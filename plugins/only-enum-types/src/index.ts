import {CodegenPlugin, PluginFunction} from '@graphql-codegen/plugin-helpers';
import {parse, printSchema, visit} from 'graphql';
import {TsVisitor} from '@graphql-codegen/typescript';

/*
  By defining a visitor returning null for all TypeDefinition nodes with the only exception of EnumTypeDefinition, we
    can cut down the AST significantly before handing it to the TsVisitor of the typescript plugin.
 */
// noinspection JSUnusedGlobalSymbols
class EnumFilterVisitor {
  ObjectTypeDefinition() {
    return null;
  }
  ScalarTypeDefinition() {
    return null;
  }
  UnionTypeDefinition() {
    return null;
  }
  InputObjectTypeDefinition() {
    return null;
  }
  InterfaceTypeDefinition() {
    return null;
  }
}

const plugin: PluginFunction = (schema, documents, config) => {
  const printedSchema = printSchema(schema);
  const astNode = parse(printedSchema);

  const filterVisitor = new EnumFilterVisitor();
  const filteredAst = visit(astNode, {enter: filterVisitor});

  const visitor = new TsVisitor(schema, config);
  const result = visit(filteredAst, {leave: visitor});

  return {
    prepend: visitor.getWrapperDefinitions(),
    content: result.definitions.join('\n'),
  };
};

const pluginConf: CodegenPlugin = {plugin};

module.exports = pluginConf;
