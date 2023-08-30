import {TypeScriptDocumentsPluginConfig, TypeScriptDocumentsVisitor} from '@graphql-codegen/typescript-operations';
import {
  BaseVisitorConvertOptions,
  ConvertNameFn,
  DeclarationBlock,
  FragmentImport,
  generateFragmentImportStatement,
  GetFragmentSuffixFn,
  getPossibleTypes,
  ImportDeclaration,
  InterfaceOrVariable,
  LoadedFragment,
  NameAndType,
  NormalizedScalarsMap,
  optimizeOperations,
  ParsedDocumentsConfig,
  PreResolveTypesProcessor,
  PrimitiveField,
  ProcessResult,
  SelectionSetProcessorConfig,
  SelectionSetToObject,
  wrapTypeWithModifiers,
} from '@graphql-codegen/visitor-plugin-common';
import {CodegenPlugin, getBaseType, PluginFunction, Types} from '@graphql-codegen/plugin-helpers';
import {
  concatAST,
  DirectiveNode,
  DocumentNode,
  FieldNode,
  FragmentDefinitionNode,
  GraphQLInputObjectType,
  GraphQLInterfaceType,
  GraphQLNamedType,
  GraphQLObjectType,
  GraphQLOutputType,
  GraphQLSchema,
  GraphQLType,
  InputObjectTypeDefinitionNode,
  InterfaceTypeDefinitionNode,
  isEnumType,
  isEqualType,
  isInputObjectType,
  isInterfaceType,
  isNonNullType,
  isObjectType,
  Kind,
  ListTypeNode,
  NamedTypeNode,
  ObjectTypeDefinitionNode,
  OperationDefinitionNode,
  parse,
  printSchema,
  SelectionNode,
  SelectionSetNode,
  StringValueNode,
  TypeDefinitionNode,
  TypeNode,
  VariableDefinitionNode,
  visit,
} from 'graphql';
import * as autoBind from 'auto-bind';
import {TsVisitor, TypeScriptOperationVariablesToObject} from '@graphql-codegen/typescript';
import {Maybe} from 'graphql/jsutils/Maybe';

// Copied from selection-set-to-object.ts in @graphql-codegen/visitor-plugin-common
declare type FragmentSpreadUsage = {
  fragmentName: string;
  typeName: string;
  onType: string;
  selectionNodes: Array<SelectionNode>;
}

/**
 * A simplified (and slightly imprecise) version of a node for the function below
 */
type DefNode = {kind: string; type?: DefNode; name?: {value: string}};

/**
 * A function returning the named type of a variable or field
 *
 * @param variableDef A definition node containing a NamedType in its structure
 */
const getNamedTypeName = (variableDef: DefNode): string =>
  variableDef.kind === 'NamedType' ? variableDef.name?.value ?? '' : getNamedTypeName(variableDef.type!);

// noinspection JSUnusedGlobalSymbols
/**
 * A visitor class to extract all TypeDefinition nodes with a given name.
 *
 * This works by passing a string array with the required types and on each InputObject-, Object- and
 *  InterfaceTypeDefinition their name is looked up in that array. If it's required it remains in the ast, otherwise
 *  it is removed by returning null.
 *
 * Enum and Scalar definitions are excluded as they are already defined in a "global" scope.
 * Union definitions are excluded as they guaranteed not to be used and only result in broken types across all operations.
 */
class TypeCollectorVisitor {
  typesToInclude: string[];

  constructor(typesToInclude: string[]) {
    this.typesToInclude = typesToInclude;
    autoBind(this);
  }

  public DirectiveDefinition() {
    return null;
  }

  public DirectiveTypeDefinition() {
    return null;
  }

  public EnumTypeDefinition() {
    return null;
  }

  public ScalarTypeDefinition() {
    return null;
  }

  public UnionTypeDefinition() {
    return null;
  }

  /**
   * Filtering function that returns the input node or null depending on whether its name is in the typesToInclude or
   * not
   *
   * @param node The node to check
   */
  private _ifTypeIncluded<T extends TypeDefinitionNode>(node: T): T | null {
    const name = node.name.value;

    return this.typesToInclude.includes(name) ? node : null;
  }

  public InputObjectTypeDefinition(node: InputObjectTypeDefinitionNode): InputObjectTypeDefinitionNode | null {
    return this._ifTypeIncluded(node);
  }

  public InterfaceTypeDefinition(node: InterfaceTypeDefinitionNode): InterfaceTypeDefinitionNode | null {
    return this._ifTypeIncluded(node);
  }

  public ObjectTypeDefinition(node: ObjectTypeDefinitionNode): ObjectTypeDefinitionNode | null {
    return this._ifTypeIncluded(node);
  }
}

/**
 * A custom extension of the real TsVisitor to generate types as defined in the concept:
 *
 * Scalar types are preresolved to avoid Scalar['String'] constructs
 * Nullable types are generated as T | null instead of Maybe<T>
 * Prepend the namespacedImportName (usually Types) to enum types from the "global" file in generated types.
 */
class CustomTsVisitor extends TsVisitor {
  private nullableSuffix = ' | null';

  constructor(schema: GraphQLSchema, private pluginConfig: any) {
    super(schema, pluginConfig);
  }

  /**
   * Called by the TsVisitor to determine the string representation of a named scalar
   *
   * Original implementation returned `Scalar['${name}']`; this adaption resolves it from the internal map of scalars
   *
   * @param name Name of the scalar to get the type string for.
   * @param type Whether the scalar is an input or output scalar.
   */
  protected _getScalar(name: string, type: 'input' | 'output'): string {
    return this.scalars[name][type] || super._getScalar(name, type);
  }

  /**
   * Called by the TsVisitor to clear the optional declaration from nodes that are NotNullTypes
   *
   * The original implementation removed Maybe<>; this is an adaption to the requirement for | null
   *
   * @param str String containing the typedefinition the optional should be removed from.
   */
  public clearOptional(str: string) {
    if (str.endsWith(this.nullableSuffix)) {
      return str.substring(0, str.length - this.nullableSuffix.length);
    }

    return str;
  }

  /**
   * Called by the TsVisitor to transform a NamedType to its string representation
   *
   * The original implementation wrapped the result of a super call in Maybe<>; this adaption is a copy from that super
   * call's code adding the nullable suffix
   *
   * @param node NamedTypeNode the type string should be generated for.
   * @param isVisitingInputType Whether the Visitor is currently visiting an input type
   */
  public NamedType(node: NamedTypeNode, isVisitingInputType: boolean) {
    return this._getTypeForNode(node, isVisitingInputType) + this.nullableSuffix;
  }

  /**
   * Called by the TsVisitor to transform a ListType to its string representation
   *
   * The original implementation wrapped the result of a super call in Maybe<>; this adaption is a copy from that super
   * call's code adding the nullable suffix
   *
   * @param node ListTypeNode the type string should be generated for.
   */
  public ListType(node: ListTypeNode) {
    const asString = node.type.toString();
    const listType = this.wrapWithListType(asString);

    return listType + this.nullableSuffix;
  }

  /**
   * Called by the TsVisitor to determine the flat typename for a node.
   * Extended to prepend Types. to enum types; rest is handled by the default implementation
   *
   * @param node The node the type should be determined for
   * @param isVisitingInputType Whether the Visitor is currently visiting an input type
   */
  protected _getTypeForNode(node: NamedTypeNode, isVisitingInputType: boolean) {
    // The fixed signature of this is inaccurate. The values passed often (always?) don't a name.value field; just name
    const schemaType = this._schema.getType(node.name.value ?? node.name);
    if (schemaType && isEnumType(schemaType)) {
      return (
        this.pluginConfig.namespacedImportName + '.' + this.convertName(node, {useTypesPrefix: this.config.enumPrefix})
      );
    }

    return super._getTypeForNode(node, isVisitingInputType);
  }
}

/**
 * Class converting the operation variables of a mutation or query to an object
 *
 * This extension of the original implementation serves the following purposes:
 *
 * Remove Types. prefix of classes that are generated in local scope (like input types)
 * Add Types. prefix to enums
 * Pre resolve Scalars
 */
class CustomOperationVariablesToObject extends TypeScriptOperationVariablesToObject {
  private _getBaseTypeNode(typeNode: TypeNode): NamedTypeNode {
    if (typeNode.kind === Kind.LIST_TYPE || typeNode.kind === Kind.NON_NULL_TYPE) {
      return this._getBaseTypeNode(typeNode.type);
    }

    return typeNode;
  }

  /**
   * Called by the transformer to transform an operation variable definition to a TS object field definition
   *
   * This is a copy from the original implementation with slight adjustments where needed to:
   *
   * Remove Types. prefix of classes that are generated in local scope (like input types)
   * Add Types. prefix to enums
   * Pre resolve Scalars
   *
   * @param variable An operation Variable Definition to transform to a string
   */
  protected transformVariable<TDefinitionType extends InterfaceOrVariable>(variable: TDefinitionType): string {
    let typeValue: string;
    const prefix = this._namespacedImportName ? `${this._namespacedImportName}.` : '';

    const baseType = this._getBaseTypeNode(variable.type);
    const typeName = baseType.name.value;
    if (this._scalars[typeName]) {
      const scalar = this._scalars[typeName];
      typeValue = scalar.input ?? scalar.output;
    } else if (this._enumValues[typeName]?.sourceFile) {
      typeValue = this._enumValues[typeName].typeIdentifier || this._enumValues[typeName].sourceIdentifier || '';
    } else if (this._enumNames.includes(typeName)) {
      typeValue =
        prefix +
        this._convertName(baseType, {
          useTypesPrefix: this._enumPrefix,
        });
    } else {
      typeValue = this._convertName(baseType);
    }

    const fieldName = this.getName(variable);
    const fieldType = this.wrapAstTypeWithModifiers(typeValue, variable.type);
    const hasDefaultValue = variable.defaultValue != null && typeof variable.defaultValue !== 'undefined';
    const isNonNullType = variable.type.kind === Kind.NON_NULL_TYPE;
    const formattedFieldString = this.formatFieldString(fieldName, isNonNullType, hasDefaultValue);
    const formattedTypeString = this.formatTypeString(fieldType, isNonNullType, hasDefaultValue);

    return `${formattedFieldString}: ${formattedTypeString}`;
  }
}

type ExportMarkedTypeName = {marker: true; fieldName: string; exportedTypeName: string};
type ExportNodeTypeMapping = {
  node: SelectionNode;
  type: GraphQLObjectType | GraphQLInterfaceType;
  parentType: GraphQLObjectType | GraphQLInterfaceType;
  alias: string;
};

/**
 * Custom types processor to ensure that exported fields get to keep their name
 */
class CustomPreResolveTypesProcessor extends PreResolveTypesProcessor {
  constructor(processorConfig: SelectionSetProcessorConfig) {
    super(processorConfig);
  }

  exportAliases: Map<GraphQLObjectType | GraphQLInterfaceType, Map<string, string>> = new Map<GraphQLObjectType | GraphQLInterfaceType, Map<string, string>>();

  registerExportAlias(parentSchemaType: GraphQLObjectType | GraphQLInterfaceType, fieldName: string, exportedTypeName: string) {
    if (!this.exportAliases.has(parentSchemaType)) {
      this.exportAliases.set(parentSchemaType, new Map<string, string>());
    }

    this.exportAliases.get(parentSchemaType)!.set(fieldName, exportedTypeName);
  }

  transformPrimitiveFields(schemaType: GraphQLObjectType | GraphQLInterfaceType, fields: PrimitiveField[]): ProcessResult {
    const exportAliasMap = this.exportAliases.get(schemaType);

    const regularFields = fields.filter((x) => !exportAliasMap?.has(x.fieldName));
    const exportedFields = fields.filter((x) => exportAliasMap?.has(x.fieldName));

    const transformedPrimitiveFields = super.transformPrimitiveFields(schemaType, regularFields) ?? [];
    const exportedNameAndType = exportedFields.map((x): NameAndType => ({name: x.fieldName, type: exportAliasMap!.get(x.fieldName)!}));

    return [...exportedNameAndType, ...transformedPrimitiveFields];
  }
}

/**
 * Transformer class for graphql selection sets.
 *
 * Most functions here are copied from the original implementation and slightly adapted because they don't seem to be
 *  designed for overwriting them.
 */
class CustomSelectionSetToObject extends SelectionSetToObject {
  constructor(
    processor: CustomPreResolveTypesProcessor,
    scalars: NormalizedScalarsMap,
    schema: GraphQLSchema,
    convertName: ConvertNameFn<BaseVisitorConvertOptions>,
    getFragmentSuffix: GetFragmentSuffixFn,
    loadedFragments: LoadedFragment[],
    config: ParsedDocumentsConfig,
    parentSchemaType?: GraphQLNamedType,
    selectionSet?: SelectionSetNode,
  ) {
    super(
      processor,
      scalars,
      schema,
      convertName,
      getFragmentSuffix,
      loadedFragments,
      config,
      parentSchemaType,
      selectionSet,
    );
    autoBind(this);
  }

  /**
   * Convenience function to create aliases for subtypes of interfaces
   *
   * @param type The named type the alias should be generated for
   * @param mainAlias The alias of the exported interface type field's export directive
   */
  private static _getInterfaceAlias(type: GraphQLNamedType, mainAlias: string) {
    return `${mainAlias}_${type.name}`;
  }

  /**
   * Returns the export alias of a field node or throws if either the export directive or the exportName is missing.
   *
   * @param node FieldNode to get the export alias for
   */
  private static _getExportedAlias(node: FieldNode): string {
    const exportDirective = node.directives?.find((directive) => directive.name.value === 'export');
    if (!exportDirective) {
      throw new Error(
        `Couldn't find export directive when trying to find the exported alias. FieldNode name is ${node.name}`,
      );
    }
    const nameArg = exportDirective.arguments?.find((arg) => arg.name.value === 'exportName');
    if (!nameArg) {
      throw new Error(
        `Couldn't find exportName on export directive when trying to find the exported alias. FieldNode name is ${node.name}`,
      );
    }

    return (nameArg.value as StringValueNode).value;
  }

  /**
   * Creates a new instance of the SelectionSetToObject for another selection set
   * @param parentSchemaType ParentSchemaType of the selection set
   * @param selectionSet selection set to be used as base selection set for the new object
   */
  public createNext(parentSchemaType: GraphQLNamedType, selectionSet: SelectionSetNode): SelectionSetToObject {
    return new CustomSelectionSetToObject(
      this._processor as CustomPreResolveTypesProcessor,
      this._scalars,
      this._schema,
      this._convertName.bind(this),
      this._getFragmentSuffix.bind(this),
      this._loadedFragments,
      this._config,
      parentSchemaType,
      selectionSet,
    );
  }

  /**
   * Converts an array of selections to a SelectionSetNode
   * @param selections Array of SelectionNodes to be set as selections of the SelectionSetNode
   */
  private static _selectionsToSelectionSet(selections: ReadonlyArray<SelectionNode>): SelectionSetNode {
    return {
      kind: Kind.SELECTION_SET,
      selections,
    };
  }


  protected buildSelectionSet(parentSchemaType: GraphQLObjectType, selectionNodes: Array<SelectionNode | FragmentSpreadUsage | DirectiveNode | ExportMarkedTypeName>): {
    typeInfo: {
      name: string;
      type: string;
    };
    fields: string[];
  } {
    const isExportMarkedType = (
      selectionNode: SelectionNode | FragmentSpreadUsage | DirectiveNode | ExportMarkedTypeName,
    ): selectionNode is ExportMarkedTypeName => (selectionNode as ExportMarkedTypeName).marker;

    const exported = selectionNodes.filter(isExportMarkedType);
    const forwarded = selectionNodes.filter((node) => !isExportMarkedType(node)) as (SelectionNode | FragmentSpreadUsage | DirectiveNode)[];

    for (const {fieldName, exportedTypeName} of exported) {
      (this._processor as CustomPreResolveTypesProcessor).registerExportAlias(parentSchemaType, fieldName, exportedTypeName);
    }

    const cheekyTrick = exported.map(({fieldName, exportedTypeName}) => ({name: {value: fieldName, kind: Kind.NAME}, type: exportedTypeName, kind: Kind.FIELD}));

    return super.buildSelectionSet(parentSchemaType, [...forwarded, ...cheekyTrick]);
  }

  /**
   * Flattens the selection set by trimming off irrelevant bits and converting fragments to a form that's easier to work
   *  with.
   *
   * This implementation manipulates the returned map of the super call by going through the fields and patching those
   *  that should be exported
   *
   * @param selections A list of SelectionNodes of a selection set
   */
  protected flattenSelectionSet(selections: ReadonlyArray<SelectionNode>): Map<string, Array<SelectionNode | FragmentSpreadUsage>> {
    if (!this._parentSchemaType) {
      return new Map();
    }

    const isFieldNode = (node: SelectionNode | FragmentSpreadUsage | ExportMarkedTypeName): node is FieldNode => {
      return (node as SelectionNode).kind === "Field";
    };

    const map: Map<string, (SelectionNode | FragmentSpreadUsage | ExportMarkedTypeName)[]> = super.flattenSelectionSet(selections);
    for (const [currentTypeName, fields] of map.entries()) {
      const fieldsWithExports = fields.map((field) => {
        if (
          !isFieldNode(field) ||
          !field.directives ||
          field.directives.every((directive) => directive.name.value !== 'export')
        ) {
          return field;
        }
        const exportUsage = this.buildExportUsage(field);
        const usage = exportUsage.get(currentTypeName);
        return usage ?? field;
      });

      map.set(currentTypeName, fieldsWithExports);
    }

    return map as Map<string, Array<SelectionNode | FragmentSpreadUsage>>;
  }

  /**
   * Function to flatten the selection set on a given type that is not the base type
   *
   * @param selections A list of SelectionNodes of a selection set
   * @param type The type the selection is performed on
   */
  private _flattenFromType(
    selections: ReadonlyArray<SelectionNode>,
    type: GraphQLNamedType,
  ): Map<string, Array<SelectionNode | FragmentSpreadUsage | ExportMarkedTypeName>> {
    if (!this._parentSchemaType || isEqualType(type, this._parentSchemaType)) {
      return this.flattenSelectionSet(selections);
    }
    const subSelectionSet = this.createNext(
      type,
      CustomSelectionSetToObject._selectionsToSelectionSet(selections),
    ) as CustomSelectionSetToObject;

    return subSelectionSet.flattenSelectionSet(selections);
  }

  /**
   * Function converting a series of selectionNodes to a large selection set string in the form of a type definition.
   *
   * This implementation appends the exported field definitions to the result of a super call.
   *
   * @param parentSchemaType Parent Schema Type the selection is performed on
   * @param selectionNodes Selection nodes. A string indicates a FragmentSpread being used, an object with
   *  {marker: true} indicates an exported node, all other objects are SelectionNodes
   */
  protected buildSelectionSetString(
    parentSchemaType: GraphQLObjectType,
    selectionNodes: Array<SelectionNode | FragmentSpreadUsage | DirectiveNode | ExportMarkedTypeName>,
  ): string {
    const isExportMarkedType = (
      selectionNode: SelectionNode | FragmentSpreadUsage | DirectiveNode | ExportMarkedTypeName,
    ): selectionNode is ExportMarkedTypeName => (selectionNode as ExportMarkedTypeName).marker;

    const exported = selectionNodes.filter(isExportMarkedType);
    const forwarded = selectionNodes.filter((node) => !isExportMarkedType(node)) as (SelectionNode | FragmentSpreadUsage | DirectiveNode)[];

    const superSelectionSet = super.buildSelectionSet(parentSchemaType, forwarded);
    const superBuildString = super.selectionSetStringFromFields(superSelectionSet.fields.filter((f) => !!f)) ?? '';

    if (exported.length === 0) {
      return superBuildString;
    }
    const isAppendable = superBuildString && superBuildString.endsWith('}');

    const exportedTransformed =
      (isAppendable ? ';' : '{') + exported.map((exp) => `${exp.fieldName}: ${exp.exportedTypeName}`).join(',') + '}';

    if (isAppendable) {
      return superBuildString.substring(0, superBuildString.length - 1) + exportedTransformed;
    }

    return this._processor.buildSelectionSetFromStrings([superBuildString, exportedTransformed]);
  }

  /**
   * Function building usages of the exported type.
   *
   * The result of this function is an object containing mappings from typenames of types defined in the schema to
   *  objects containing information on the exported field:
   *
   *  marker: true - used to indicate this as exported field in buildSelectionSetString
   *  fieldName: string - indicates the exported field's name
   *  exportedTypeName: string - value of the exportedName and name of the type that is generated from the selection
   *
   * @param exp An exported FieldNode
   */
  private buildExportUsage(exp: FieldNode): Map<string, ExportMarkedTypeName> {
    const map = new Map<string, ExportMarkedTypeName>();

    const usage = CustomSelectionSetToObject._getExportedAlias(exp);
    const schemaType = this._getExportedSchemaType(usage, true);
    const possibleTypesForExport = getPossibleTypes(this._schema, schemaType);
    for (let possibleType of possibleTypesForExport) {
      const selectedSchemaType = schemaType.getFields()[exp.name.value].type;
      const wrapped = this._processor.config.wrapTypeWithModifiers(usage, selectedSchemaType);

      if (map.has(possibleType.name)) {
        throw new Error(`Already set an export marked type name for ${possibleType.name}`);
      }
      map.set(possibleType.name, {
        marker: true,
        fieldName: exp.name.value,
        exportedTypeName: wrapped,
      });
    }

    return map;
  }

  /**
   * Extension of the original function to generate the exported types with it.
   *
   * @param fragmentName fragmentName to be forwarded to the original function
   * @param fragmentSuffix fragmentSuffix to be forwarded to the original function
   * @param declarationBlockConfig declarationBlockConfig to be forwarded to the original function
   */
  public transformFragmentSelectionSetToTypes(
    fragmentName: string,
    fragmentSuffix: string,
    declarationBlockConfig: any,
  ): string {
    return (
      super.transformFragmentSelectionSetToTypes(fragmentName, fragmentSuffix, declarationBlockConfig) +
      '\n' +
      this.getExportedTypes()
    );
  }

  /**
   * Returns a string containing concatenated declaration blocks of all exported types in this selection set.
   */
  public getExportedTypes(): string {
    if (!this._selectionSet || !this._parentSchemaType) {
      return '';
    }

    const exported = this._getExportedSelectionSets(this._selectionSet, this._parentSchemaType);
    const blocks: Record<string, string[]> = {};
    for (const {node, type, alias} of exported) {
      const fieldNode = node as FieldNode;
      const selections = [...(fieldNode.selectionSet?.selections ?? [])];
      const flattened = this._flattenFromType(selections, type);

      if (!blocks[alias]) {
        blocks[alias] = [];
      }
      if (isInterfaceType(type)) {
        blocks[alias].push(this._getInterfaceAliases(type, alias).join(' | '));
      } else {
        blocks[alias].push(this.buildSelectionSetString(type, flattened.get(type.name) ?? []));
      }
    }

    return Object.keys(blocks)
      .map(
        (typeName) =>
          new DeclarationBlock({})
            .export()
            .asKind('type')
            .withName(typeName)
            .withContent(blocks[typeName].join(' & ')).string,
      )
      .join('\n');
  }

  /**
   * Returns the schema type the exported field is selected on (parent = true) or the type the exported type is derived
   *  from (parent = false).
   *
   * @param alias Name of the field that is exported.
   * @param parent true if the parentSchemaType should be returned, false otherwise (default)
   */
  private _getExportedSchemaType(alias: string, parent: boolean = false) {
    if (!this._selectionSet || !this._parentSchemaType) {
      throw new Error(`Could not find type for alias ${alias} - selectionSet or parentSchemaType not defined`);
    }

    const exportedSelections = this._getExportedSelectionSets(this._selectionSet, this._parentSchemaType);
    const correctMapping = exportedSelections.find((mapping) => mapping.alias === alias);
    if (!correctMapping) {
      throw new Error(`Could not find type for alias ${alias}`);
    }

    return parent ? correctMapping.parentType : correctMapping.type;
  }

  /**
   * Recursively returns a list of SelectionNodes that have the export directive on them. The result includes the type
   *  of the exported field, the parentType and the alias.
   *
   * @param set The SelectionSetNode to filter exported nodes from
   * @param parentType Type of the field the selection is made on
   */
  private _getExportedSelectionSets(
    set: SelectionSetNode | undefined,
    parentType: GraphQLType,
  ): ExportNodeTypeMapping[] {
    return set
      ? set.selections
          .map((selection) => this._getExportedSelectionSetNodes(selection, parentType))
          .reduce((a, b) => [...a, ...b], [])
      : [];
  }

  /**
   * Returns a list of SelectionNodes that have the export directive on them including the passed node itself if it has
   *  the export directive on it. The result includes the type of the exported field, the parentType and the alias.
   *
   * @param node Node to get exported SelectionNodes from.
   * @param parentType Type of the field the exported node is a child of
   */
  private _getExportedSelectionSetNodes(node: SelectionNode, parentType: GraphQLType): ExportNodeTypeMapping[] {
    if (node.kind === 'InlineFragment') {
      const typeName = node.typeCondition?.name.value;
      if (!typeName) {
        throw new Error('Could not find parent typename for resolving inline spread exports');
      }
      const type = this._schema.getType(typeName);
      if (!type) {
        throw new Error('Could not find parent type for resolving inline spread exports');
      }

      return this._getExportedSelectionSets(node.selectionSet, type);
    }

    if (node.kind !== 'Field' || (!isObjectType(parentType) && !isInterfaceType(parentType))) {
      return [];
    }

    const thisNodeField = parentType.getFields()[node.name.value];
    if (!thisNodeField) {
      return [];
    }
    const thisNodeType = getBaseType(thisNodeField.type);

    const subExportedFields =
      isObjectType(thisNodeType) || isInterfaceType(thisNodeType)
        ? this._getExportedSelectionSets(node.selectionSet, thisNodeType)
        : [];

    const hasExport = node.directives && node.directives.some((directive) => directive.name.value === 'export');

    if (hasExport && isObjectType(thisNodeType)) {
      return [
        {node, type: thisNodeType, parentType, alias: CustomSelectionSetToObject._getExportedAlias(node)},
        ...subExportedFields,
      ];
    }

    if (hasExport && isInterfaceType(thisNodeType)) {
      const subTypes = getPossibleTypes(this._schema, thisNodeType);
      const mainAlias = CustomSelectionSetToObject._getExportedAlias(node);
      const interfaceExports = subTypes.map((type) => ({node, type, parentType, alias: `${mainAlias}_${type.name}`}));
      return [{node, type: thisNodeType, parentType, alias: mainAlias}, ...interfaceExports, ...subExportedFields];
    }

    if (hasExport) {
      throw new Error(
        `Type ${thisNodeType.name} is a primitive and may not be exported! Field name is ${node.name.value}`,
      );
    }

    return subExportedFields;
  }

  /**
   * Generates a string array containing the names of types of exported interface types.
   *
   * An interface can have multiple types that implement it; thus when a field of an interface type is exported, we have
   *  to generate a type for each type that implements the interface.
   *
   * @param type The interface type the aliases should be generated for.
   * @param mainAlias The exportName of the interface type field's export annotation.
   */
  private _getInterfaceAliases(type: GraphQLInterfaceType, mainAlias: string): string[] {
    return getPossibleTypes(this._schema, type).map((possibleType) =>
      CustomSelectionSetToObject._getInterfaceAlias(possibleType, mainAlias),
    );
  }
}

/**
 * A custom extension of the visitor that generates the typescript operations code to generate code as defined in the
 *  concept. The key element here is setting a custom variable's transformer.
 */
class CustomTypeScriptOperationsVisitor extends TypeScriptDocumentsVisitor {
  constructor(schema: GraphQLSchema, config: TypeScriptDocumentsPluginConfig, allFragments: LoadedFragment[]) {
    super(schema, config, allFragments);
    const wrapOptional = (type: string) => {
      return `${type} | null`;
    };
    const wrapArray = (type: string) => {
      const listModifier = this.config.immutableTypes ? 'ReadonlyArray' : 'Array';
      return `${listModifier}<${type}>`;
    };

    const formatNamedField = (name: string, type: GraphQLOutputType | null): string => {
      const optional = !this.config.avoidOptionals.field && !!type && !isNonNullType(type);
      return (this.config.immutableTypes ? `readonly ${name}` : name) + (optional ? '?' : '');
    };

    const processorConfig: SelectionSetProcessorConfig = {
      namespacedImportName: this.config.namespacedImportName,
      convertName: this.convertName.bind(this),
      enumPrefix: this.config.enumPrefix,
      enumSuffix: this.config.enumSuffix,
      scalars: this.scalars,
      formatNamedField,
      wrapTypeWithModifiers(baseType, type) {
        return wrapTypeWithModifiers(baseType, type, {wrapOptional, wrapArray});
      },
    };
    const processor = new CustomPreResolveTypesProcessor(processorConfig);
    this.setSelectionSetHandler(
      new CustomSelectionSetToObject(
        processor,
        this.scalars,
        this.schema,
        this.convertName.bind(this),
        this.getFragmentSuffix.bind(this),
        allFragments,
        this.config,
      ),
    );

    const enumsNames = Object.keys(schema.getTypeMap()).filter((typeName) => isEnumType(schema.getType(typeName)));
    this.setVariablesTransformer(
      new CustomOperationVariablesToObject(
        this.scalars,
        this.convertName.bind(this),
        !!this.config.avoidOptionals.object,
        this.config.immutableTypes,
        this.config.namespacedImportName,
        enumsNames,
        this.config.enumPrefix,
        this.config.enumSuffix,
        this.config.enumValues,
      ),
    );
  }

  /**
   * Copy of a non-exported util function. Returns the schema root type for a given operation
   *
   * @param operation Operation name. One of 'query', 'mutation', 'subscription'.
   * @param schema The schema the root type is going to be looked up from.
   */
  private static _getRootType(operation: 'query' | 'mutation' | 'subscription', schema: GraphQLSchema) {
    switch (operation) {
      case 'query':
        return schema.getQueryType();
      case 'mutation':
        return schema.getMutationType();
      case 'subscription':
        return schema.getSubscriptionType();
    }
  }

  /**
   * Extension of the original OperationDefinition function to lookup and generate exported types
   *
   * @param node The OperationDefinitionNode that is the current target of AST-Visiting
   */
  public OperationDefinition(node: OperationDefinitionNode): string {
    const operationRootType = CustomTypeScriptOperationsVisitor._getRootType(node.operation, this._schema);
    if (!operationRootType) {
      throw new Error(`Unable to find root schema type for operation type "${node.operation}"!`);
    }
    const selectionSet = this._selectionSetToObject.createNext(
      operationRootType,
      node.selectionSet,
    ) as CustomSelectionSetToObject;
    const exported = selectionSet.getExportedTypes();

    return super.OperationDefinition(node) + '\n' + exported;
  }
}

/**
 * Returns an array of typenames referenced by requiredTypes
 *
 * This method recursively includes types referenced by other types.
 *
 * @param schema GraphQL schema that was passed to the plugin
 * @param requiredTypes A string list of required types
 * @param previouslyReferenced An array containing already referenced types
 */
const getSubTypeNames = (
  schema: GraphQLSchema,
  requiredTypes: string[],
  previouslyReferenced: string[] = [],
): string[] => {
  if (requiredTypes.length === 0) {
    return [];
  }

  const fieldedGraphQLTypeFilter = (
    type: Maybe<GraphQLNamedType>,
  ): type is GraphQLObjectType | GraphQLInterfaceType | GraphQLInputObjectType =>
    isObjectType(type) || isInterfaceType(type) || isInputObjectType(type);

  const schemaTypes = requiredTypes.map((type) => schema.getType(type)).filter(fieldedGraphQLTypeFilter);
  const subFields = schemaTypes.map((type) => Object.values(type.getFields())).reduce((a, b) => [...a, ...b], []);
  const subTypes = subFields.map((field) => getBaseType(field.type)).filter(fieldedGraphQLTypeFilter);
  const subTypeNames = subTypes.map((type) => type.name);

  const newPrevious = [...requiredTypes, ...previouslyReferenced];
  const newRequired = subTypeNames.filter((name) => !newPrevious.includes(name));

  const foundTypes = [...subTypeNames, ...getSubTypeNames(schema, newRequired, newPrevious)];

  return [...new Set(foundTypes)];
};

/**
 * Returns a list of all type names referenced by operations in a DocumentNode
 *
 * @param node DocumentNode containing the operations from which types should be extracted
 */
const getRequiredTypeNames = (node: DocumentNode): string[] => {
  const operations = node.definitions.filter((def) => def.kind === 'OperationDefinition') as OperationDefinitionNode[];
  if (!operations) {
    return [];
  }

  const allVariableDefinitions = operations
    .map((operation) => operation.variableDefinitions)
    .filter((defs): defs is VariableDefinitionNode[] => !!defs)
    .reduce((a, b) => [...a, ...b], [])
    ?.filter((def) => def.kind === 'VariableDefinition');

  if (!allVariableDefinitions) {
    return [];
  }

  const typeNames = allVariableDefinitions.map((def) => getNamedTypeName(def));

  return [...new Set(typeNames)];
};

/**
 * Function generating a list of lines containing the type definitions of the types required for this document
 *
 * @param documents List of documents to generate the types for
 * @param ast The full schema AST
 * @param schema The schema passed to the plugin to pass to the TsVisitor
 * @param pluginConfig The plugin config passed to the plugin to pass to the TsVisitor
 */
function getTypeContent(
  documents: Types.DocumentFile[],
  ast: DocumentNode,
  schema: GraphQLSchema,
  pluginConfig: any,
): string[] {
  // Note: This is not perfect because requiredTypeNames can contain scalars and enums, but they are thrown out
  //  in the process of searching type definitions either way.
  const requiredTypeNames = documents
    .map((document) => document.document)
    .filter((document): document is DocumentNode => !!document)
    .map((document) => getRequiredTypeNames(document))
    .reduce((a, b) => [...a, ...b]);
  const allTypeNames = [...requiredTypeNames, ...getSubTypeNames(schema, requiredTypeNames)];

  const astReducer = new TypeCollectorVisitor(allTypeNames);
  const reducedAst = visit(ast, {leave: astReducer});

  const tsVisitor = new CustomTsVisitor(schema, pluginConfig);

  // @ts-expect-error Mismatch between graphql and graphql-codegen
  const generatedDefinitions = visit(reducedAst, {leave: tsVisitor});

  return generatedDefinitions.definitions.join('\n');
}

const plugin: PluginFunction = (schema, rawDocuments, config) => {
  const documents = config.flattenGeneratedTypes ? optimizeOperations(schema, rawDocuments) : rawDocuments;
  const allAst = concatAST(documents.map((v) => v.document).filter((d): d is DocumentNode => !!d));

  const printed = printSchema(schema);
  const node = parse(printed);

  const generatedTs = getTypeContent(documents, node, schema, config);

  const allFragments = [
    ...(allAst.definitions.filter((d) => d.kind === Kind.FRAGMENT_DEFINITION) as FragmentDefinitionNode[]).map(
      (fragmentDef) => ({
        node: fragmentDef,
        name: fragmentDef.name.value,
        onType: fragmentDef.typeCondition.name.value,
        isExternal: false,
      }),
    ),
    ...(config.externalFragments || []),
  ];

  const visitor = new CustomTypeScriptOperationsVisitor(schema, config, allFragments);
  const result = visit(allAst, {leave: visitor});

  const imports = config.fragmentImports
    ?.map((i: ImportDeclaration<FragmentImport>) => generateFragmentImportStatement(i, 'type'))
    .join('\n');

  return {prepend: [imports], content: [generatedTs, result.definitions.join('\n')].join('\n')};
};

const pluginInformation: CodegenPlugin = {plugin};

module.exports = pluginInformation;
