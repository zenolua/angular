/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {ComponentFactory} from '@angular/core';

import {CompileDirectiveMetadata, CompileIdentifierMetadata, CompilePipeMetadata, createHostComponentMeta} from './compile_metadata';
import {DirectiveNormalizer} from './directive_normalizer';
import {ListWrapper} from './facade/collection';
import {BaseException} from './facade/exceptions';
import {OutputEmitter} from './output/abstract_emitter';
import * as o from './output/output_ast';
import {StyleCompiler, StylesCompileResult} from './style_compiler';
import {TemplateParser} from './template_parser';
import {assetUrl} from './util';
import {ComponentFactoryDependency, ViewCompileResult, ViewCompiler, ViewFactoryDependency} from './view_compiler/view_compiler';
import {XHR} from './xhr';

var _COMPONENT_FACTORY_IDENTIFIER = new CompileIdentifierMetadata({
  name: 'ComponentFactory',
  runtime: ComponentFactory,
  moduleUrl: assetUrl('core', 'linker/component_factory')
});

export class SourceModule {
  constructor(public moduleUrl: string, public source: string) {}
}

export class StyleSheetSourceWithImports {
  constructor(public source: SourceModule, public importedUrls: string[]) {}
}

export class NormalizedComponentWithViewDirectives {
  constructor(
      public component: CompileDirectiveMetadata, public directives: CompileDirectiveMetadata[],
      public pipes: CompilePipeMetadata[]) {}
}

export class OfflineCompiler {
  constructor(
      private _directiveNormalizer: DirectiveNormalizer, private _templateParser: TemplateParser,
      private _styleCompiler: StyleCompiler, private _viewCompiler: ViewCompiler,
      private _outputEmitter: OutputEmitter, private _xhr: XHR) {}

  normalizeDirectiveMetadata(directive: CompileDirectiveMetadata):
      Promise<CompileDirectiveMetadata> {
    return this._directiveNormalizer.normalizeDirective(directive);
  }

  compileTemplates(components: NormalizedComponentWithViewDirectives[]): SourceModule {
    if (components.length === 0) {
      throw new BaseException('No components given');
    }
    var statements: o.DeclareVarStmt[] = [];
    var exportedVars: string[] = [];
    var moduleUrl = _ngfactoryModuleUrl(components[0].component.type);
    components.forEach(componentWithDirs => {
      var compMeta = <CompileDirectiveMetadata>componentWithDirs.component;
      _assertComponent(compMeta);
      var compViewFactoryVar = this._compileComponent(
          compMeta, componentWithDirs.directives, componentWithDirs.pipes, statements);
      exportedVars.push(compViewFactoryVar);

      var hostMeta = createHostComponentMeta(compMeta.type, compMeta.selector);
      var hostViewFactoryVar = this._compileComponent(hostMeta, [compMeta], [], statements);
      var compFactoryVar = _componentFactoryName(compMeta.type);
      statements.push(
          o.variable(compFactoryVar)
              .set(o.importExpr(_COMPONENT_FACTORY_IDENTIFIER, [o.importType(compMeta.type)])
                       .instantiate(
                           [
                             o.literal(compMeta.selector), o.variable(hostViewFactoryVar),
                             o.importExpr(compMeta.type)
                           ],
                           o.importType(
                               _COMPONENT_FACTORY_IDENTIFIER, [o.importType(compMeta.type)],
                               [o.TypeModifier.Const])))
              .toDeclStmt(null, [o.StmtModifier.Final]));
      exportedVars.push(compFactoryVar);
    });
    return this._codegenSourceModule(moduleUrl, statements, exportedVars);
  }

  loadAndCompileStylesheet(stylesheetUrl: string, shim: boolean, suffix: string):
      Promise<StyleSheetSourceWithImports> {
    return this._xhr.get(stylesheetUrl).then((cssText) => {
      var compileResult = this._styleCompiler.compileStylesheet(stylesheetUrl, cssText, shim);
      var importedUrls: string[] = [];
      compileResult.dependencies.forEach((dep) => {
        importedUrls.push(dep.moduleUrl);
        dep.valuePlaceholder.moduleUrl = _stylesModuleUrl(dep.moduleUrl, dep.isShimmed, suffix);
      });
      return new StyleSheetSourceWithImports(
          this._codgenStyles(stylesheetUrl, shim, suffix, compileResult), importedUrls);
    });
  }

  private _compileComponent(
      compMeta: CompileDirectiveMetadata, directives: CompileDirectiveMetadata[],
      pipes: CompilePipeMetadata[], targetStatements: o.Statement[]): string {
    var styleResult = this._styleCompiler.compileComponent(compMeta);
    var parsedTemplate = this._templateParser.parse(
        compMeta, compMeta.template.template, directives, pipes, compMeta.type.name);
    var viewResult = this._viewCompiler.compileComponent(
        compMeta, parsedTemplate, o.variable(styleResult.stylesVar), pipes);
    ListWrapper.addAll(
        targetStatements, _resolveStyleStatements(compMeta.type.moduleUrl, styleResult));
    ListWrapper.addAll(targetStatements, _resolveViewStatements(viewResult));
    return viewResult.viewFactoryVar;
  }

  private _codgenStyles(
      inputUrl: string, shim: boolean, suffix: string,
      stylesCompileResult: StylesCompileResult): SourceModule {
    return this._codegenSourceModule(
        _stylesModuleUrl(inputUrl, shim, suffix), stylesCompileResult.statements,
        [stylesCompileResult.stylesVar]);
  }

  private _codegenSourceModule(
      moduleUrl: string, statements: o.Statement[], exportedVars: string[]): SourceModule {
    return new SourceModule(
        moduleUrl, this._outputEmitter.emitStatements(moduleUrl, statements, exportedVars));
  }
}

function _resolveViewStatements(compileResult: ViewCompileResult): o.Statement[] {
  compileResult.dependencies.forEach((dep) => {
    if (dep instanceof ViewFactoryDependency) {
      dep.placeholder.moduleUrl = _ngfactoryModuleUrl(dep.comp.type);
    } else if (dep instanceof ComponentFactoryDependency) {
      dep.placeholder.name = _componentFactoryName(dep.comp);
      dep.placeholder.moduleUrl = _ngfactoryModuleUrl(dep.comp);
    }
  });
  return compileResult.statements;
}


function _resolveStyleStatements(
    containingModuleUrl: string, compileResult: StylesCompileResult): o.Statement[] {
  var containingSuffix = _splitSuffix(containingModuleUrl)[1];
  compileResult.dependencies.forEach((dep) => {
    dep.valuePlaceholder.moduleUrl =
        _stylesModuleUrl(dep.moduleUrl, dep.isShimmed, containingSuffix);
  });
  return compileResult.statements;
}

function _ngfactoryModuleUrl(comp: CompileIdentifierMetadata): string {
  var urlWithSuffix = _splitSuffix(comp.moduleUrl);
  return `${urlWithSuffix[0]}.ngfactory${urlWithSuffix[1]}`;
}

function _componentFactoryName(comp: CompileIdentifierMetadata): string {
  return `${comp.name}NgFactory`;
}

function _stylesModuleUrl(stylesheetUrl: string, shim: boolean, suffix: string): string {
  return shim ? `${stylesheetUrl}.shim${suffix}` : `${stylesheetUrl}${suffix}`;
}

function _assertComponent(meta: CompileDirectiveMetadata) {
  if (!meta.isComponent) {
    throw new BaseException(`Could not compile '${meta.type.name}' because it is not a component.`);
  }
}

function _splitSuffix(path: string): string[] {
  let lastDot = path.lastIndexOf('.');
  if (lastDot !== -1) {
    return [path.substring(0, lastDot), path.substring(lastDot)];
  } else {
    return [path, ''];
  }
}
