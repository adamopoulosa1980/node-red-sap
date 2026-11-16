'use strict';

const { XMLParser } = require('fast-xml-parser');

const ARRAY_TAGS = new Set([
  'Schema',
  'EntityType',
  'ComplexType',
  'EnumType',
  'Member',
  'Property',
  'PropertyRef',
  'NavigationProperty',
  'NavigationPropertyBinding',
  'EntitySet',
  'Singleton',
  'FunctionImport',
  'ActionImport',
  'Function',
  'Action',
  'Parameter',
  'EntityContainer',
  'Association',
  'AssociationSet',
  'End',
  'Reference',
  'Include',
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  removeNSPrefix: true,
  parseAttributeValue: false,
  // attributes such as EntitySet/@EntityType or FunctionImport/@Function share names with elements
  isArray: (name, jpath, isLeafNode, isAttribute) => !isAttribute && ARRAY_TAGS.has(name),
});

const arr = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const shortName = (qualified) => (qualified ? String(qualified).split('.').pop() : qualified);

/**
 * Parses an EDMX $metadata document (OData V2 or V4) into a compact model.
 * @returns {{version:'v2'|'v4', namespaces:string[], entitySets:object, entityTypes:object, complexTypes:object, operations:object}}
 */
function parseMetadata(xml) {
  const doc = parser.parse(xml);
  const edmx = doc.Edmx;
  if (edmx === undefined) throw new Error('Not an EDMX $metadata document');
  const version = String(edmx.Version || '').startsWith('4') ? 'v4' : 'v2';
  const schemas = arr(edmx.DataServices && edmx.DataServices.Schema);

  const entityTypes = {};
  const complexTypes = {};
  const operations = {};
  const entitySets = {};
  const namespaces = [];
  const aliases = {};

  const mapProperty = (p) => ({
    name: p.Name,
    type: p.Type,
    nullable: p.Nullable !== 'false',
    maxLength: p.MaxLength !== undefined ? Number(p.MaxLength) || p.MaxLength : undefined,
    precision: p.Precision !== undefined ? Number(p.Precision) : undefined,
    scale: p.Scale !== undefined ? (Number.isNaN(Number(p.Scale)) ? p.Scale : Number(p.Scale)) : undefined,
    label: p.label,
    creatable: p.creatable !== 'false',
    updatable: p.updatable !== 'false',
    filterable: p.filterable !== 'false',
  });

  for (const schema of schemas) {
    const ns = schema.Namespace;
    namespaces.push(ns);
    if (schema.Alias) aliases[schema.Alias] = ns;

    for (const et of arr(schema.EntityType)) {
      entityTypes[`${ns}.${et.Name}`] = {
        name: et.Name,
        namespace: ns,
        baseType: et.BaseType,
        keys: arr(et.Key && et.Key.PropertyRef).map((r) => r.Name),
        properties: arr(et.Property).map(mapProperty),
        navigation: arr(et.NavigationProperty).map((n) => ({
          name: n.Name,
          type: n.Type, // V4
          relationship: n.Relationship, // V2
          toRole: n.ToRole,
        })),
      };
    }
    for (const ct of arr(schema.ComplexType)) {
      complexTypes[`${ns}.${ct.Name}`] = { name: ct.Name, namespace: ns, properties: arr(ct.Property).map(mapProperty) };
    }
    // V4 schema-level functions/actions
    for (const kind of ['Function', 'Action']) {
      for (const op of arr(schema[kind])) {
        const bound = op.IsBound === 'true';
        const params = arr(op.Parameter).map((p) => ({ name: p.Name, type: p.Type, nullable: p.Nullable !== 'false' }));
        const qualified = `${ns}.${op.Name}`;
        operations[bound ? qualified : op.Name] = operations[bound ? qualified : op.Name] || {
          name: op.Name,
          qualifiedName: qualified,
          kind: kind.toLowerCase(),
          bound,
          bindingType: bound && params[0] ? params[0].type : undefined,
          parameters: bound ? params.slice(1) : params,
          returnType: op.ReturnType ? op.ReturnType.Type : undefined,
          httpMethod: kind === 'Action' ? 'POST' : 'GET',
        };
      }
    }
  }

  const resolveType = (qualified) => {
    if (!qualified) return undefined;
    const q = String(qualified).replace(/^Collection\((.*)\)$/, '$1');
    const dot = q.lastIndexOf('.');
    const nsPart = q.slice(0, dot);
    const name = q.slice(dot + 1);
    const full = `${aliases[nsPart] || nsPart}.${name}`;
    return entityTypes[full] || Object.values(entityTypes).find((t) => t.name === name);
  };

  // resolve inherited keys / properties (V4 BaseType)
  const keyProps = (type, depth = 0) => {
    if (!type || depth > 10) return [];
    const base = type.baseType ? resolveType(type.baseType) : undefined;
    const keys = type.keys.length ? type.keys : base ? base.keys : [];
    const props = [...(base ? keyPropsAll(base, depth + 1) : []), ...type.properties];
    return keys.map((k) => props.find((p) => p.name === k) || { name: k, type: 'Edm.String' }).map((p) => ({ name: p.name, type: p.type }));
  };
  const keyPropsAll = (type, depth) => {
    const base = type.baseType ? resolveType(type.baseType) : undefined;
    return [...(base && depth < 10 ? keyPropsAll(base, depth + 1) : []), ...type.properties];
  };

  for (const schema of schemas) {
    for (const container of arr(schema.EntityContainer)) {
      for (const set of arr(container.EntitySet)) {
        const type = resolveType(set.EntityType);
        entitySets[set.Name] = {
          name: set.Name,
          entityType: set.EntityType,
          keys: keyProps(type),
          properties: type ? keyPropsAll(type, 0) : [],
          navigation: type ? type.navigation.map((n) => n.name) : [],
          label: set.label,
          creatable: set.creatable !== 'false',
          updatable: set.updatable !== 'false',
          deletable: set.deletable !== 'false',
        };
      }
      for (const s of arr(container.Singleton)) {
        const type = resolveType(s.Type);
        entitySets[s.Name] = { name: s.Name, entityType: s.Type, singleton: true, keys: [], properties: type ? keyPropsAll(type, 0) : [], navigation: type ? type.navigation.map((n) => n.name) : [] };
      }
      // V2 function imports
      for (const fi of arr(container.FunctionImport)) {
        if (version === 'v4') {
          const target = operations[shortName(fi.Function)];
          operations[fi.Name] = { ...(target || { parameters: [] }), name: fi.Name, kind: 'function', bound: false, httpMethod: 'GET' };
          continue;
        }
        operations[fi.Name] = {
          name: fi.Name,
          kind: 'function',
          bound: false,
          httpMethod: (fi.HttpMethod || 'GET').toUpperCase(),
          returnType: fi.ReturnType,
          entitySet: fi.EntitySet,
          parameters: arr(fi.Parameter).map((p) => ({ name: p.Name, type: p.Type, nullable: p.Nullable !== 'false', mode: p.Mode })),
        };
      }
      for (const ai of arr(container.ActionImport)) {
        const target = operations[shortName(ai.Action)];
        operations[ai.Name] = { ...(target || { parameters: [] }), name: ai.Name, kind: 'action', bound: false, httpMethod: 'POST' };
      }
    }
  }

  return { version, namespaces, entitySets, entityTypes, complexTypes, operations };
}

/** Small serialisable summary for the editor. */
function summarize(model) {
  return {
    version: model.version,
    entitySets: Object.values(model.entitySets).map((s) => ({
      name: s.name,
      keys: s.keys,
      navigation: s.navigation,
      label: s.label,
      properties: s.properties.map((p) => ({ name: p.name, type: p.type, label: p.label })),
    })),
    operations: Object.entries(model.operations).map(([id, o]) => ({
      id,
      name: o.name,
      kind: o.kind,
      bound: o.bound,
      httpMethod: o.httpMethod,
      parameters: o.parameters,
    })),
  };
}

module.exports = { parseMetadata, summarize };
