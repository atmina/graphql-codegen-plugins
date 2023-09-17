import {oldVisit, PluginFunction} from '@graphql-codegen/plugin-helpers';
import {parse, printSchema} from 'graphql';
import {TsVisitor} from '@graphql-codegen/typescript';

/*
  By defining a visitor returning null for all TypeDefinition nodes with the only exception of EnumTypeDefinition, we
    can cut down the AST significantly before handing it to the TsVisitor of the typescript plugin.
 */
// noinspection JSUnusedGlobalSymbols
const enumFilterVisitor = {
  ObjectTypeDefinition() {
    return null;
  },
  ScalarTypeDefinition() {
    return null;
  },
  UnionTypeDefinition() {
    return null;
  },
  InputObjectTypeDefinition() {
    return null;
  },
  InterfaceTypeDefinition() {
    return null;
  },
};

export const plugin: PluginFunction = (schema, documents, config) => {
  const printedSchema = printSchema(schema);
  const astNode = parse(printedSchema);

  const filteredAst = oldVisit(astNode, {enter: enumFilterVisitor});

  const visitor = new TsVisitor(schema, config);
  // @ts-expect-error Mismatch between graphql and graphql-codegen
  const result = oldVisit(filteredAst, {leave: visitor});

  return {
    prepend: visitor.getWrapperDefinitions(),
    content: result.definitions.join('\n'),
  };
};
