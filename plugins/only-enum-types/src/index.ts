import {CodegenPlugin, PluginFunction} from '@graphql-codegen/plugin-helpers';
import {InterfaceTypeDefinitionNode, ObjectTypeDefinitionNode, parse, printSchema, visit} from 'graphql';
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

class UndefinedGuardTsVisitor extends TsVisitor {
  public ObjectTypeDefinition(node: ObjectTypeDefinitionNode, key: number | string | undefined, parent: any): string {
    if (key === undefined) throw new Error('This cannot happen and is only needed for type-safety until Upgrade to graphql 16');
    return super.ObjectTypeDefinition(node, key, parent);
  }

  public InterfaceTypeDefinition(node: InterfaceTypeDefinitionNode, key: number | string | undefined, parent: any): string {
    if (key === undefined) throw new Error('This cannot happen and is only needed for type-safety until Upgrade to graphql 16');
    return super.InterfaceTypeDefinition(node, key, parent);
  }
}

const plugin: PluginFunction = (schema, documents, config) => {
  const printedSchema = printSchema(schema);
  const astNode = parse(printedSchema);

  const filterVisitor = new EnumFilterVisitor();
  const filteredAst = visit(astNode, {enter: filterVisitor});

  const visitor = new UndefinedGuardTsVisitor(schema, config);
  const result = visit(filteredAst, {leave: visitor});

  return {
    prepend: visitor.getWrapperDefinitions(),
    content: result.definitions.join('\n'),
  };
};

const pluginConf: CodegenPlugin = {plugin};

module.exports = pluginConf;
