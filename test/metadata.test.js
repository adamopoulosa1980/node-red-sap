'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMetadata, summarize } = require('../lib/metadata');
const { V2, V4 } = require('./fixtures/metadata');

test('parseMetadata - V2 (SAP Gateway)', () => {
  const m = parseMetadata(V2);
  assert.equal(m.version, 'v2');
  assert.deepEqual(m.namespaces, ['GWSAMPLE_BASIC']);

  const bp = m.entitySets.BusinessPartnerSet;
  assert.equal(bp.entityType, 'GWSAMPLE_BASIC.BusinessPartner');
  assert.deepEqual(bp.keys, [{ name: 'BusinessPartnerID', type: 'Edm.String' }]);
  assert.equal(bp.label, 'Partners');
  assert.equal(bp.deletable, false);
  assert.equal(bp.creatable, true);
  assert.deepEqual(bp.navigation, ['ToSalesOrders']);
  const id = bp.properties[0];
  assert.deepEqual(id, {
    name: 'BusinessPartnerID',
    type: 'Edm.String',
    nullable: false,
    maxLength: 10,
    precision: undefined,
    scale: undefined,
    label: 'Business Partner ID',
    creatable: false,
    updatable: false,
    filterable: true,
  });
  assert.equal(bp.properties[1].filterable, false);
  assert.equal(bp.properties[3].precision, 16);
  assert.equal(bp.properties[3].scale, 3);
  assert.equal(bp.properties[4].scale, 'variable');
  assert.equal(bp.properties[4].maxLength, 'abc');

  assert.deepEqual(m.entitySets.SalesOrderLineItemSet.keys.map((k) => k.name), ['SalesOrderID', 'ItemPosition']);
  assert.equal(m.entitySets.SalesOrderLineItemSet.updatable, false);
  assert.deepEqual(m.entitySets.ContactSet.keys, [{ name: 'ContactGuid', type: 'Edm.Guid' }]);
  assert.deepEqual(m.entitySets.OrphanSet.keys, [{ name: 'Missing', type: 'Edm.String' }]);
  assert.deepEqual(m.entitySets.UnknownSet.keys, []);
  assert.deepEqual(m.entitySets.UnknownSet.properties, []);
  assert.deepEqual(m.entitySets.UnknownSet.navigation, []);
  assert.ok(m.complexTypes['GWSAMPLE_BASIC.CT_Address']);

  assert.deepEqual(m.operations.SalesOrder_Confirm, {
    name: 'SalesOrder_Confirm',
    kind: 'function',
    bound: false,
    httpMethod: 'POST',
    returnType: 'GWSAMPLE_BASIC.SalesOrder',
    entitySet: 'SalesOrderSet',
    parameters: [{ name: 'SalesOrderID', type: 'Edm.String', nullable: true, mode: 'In' }],
  });
  assert.equal(m.operations.GetDate.httpMethod, 'GET');
  assert.equal(m.operations.GetDate.parameters[0].nullable, false);
});

test('parseMetadata - V4 (RAP) with alias, inheritance and operations', () => {
  const m = parseMetadata(V4);
  assert.equal(m.version, 'v4');
  const p = m.entitySets.Product;
  assert.deepEqual(p.keys, [{ name: 'Product', type: 'Edm.String' }]);
  assert.deepEqual(p.properties.map((x) => x.name), ['Product', 'ProductUUID', 'CreatedOn']);
  assert.deepEqual(p.navigation, ['_Text']);
  assert.deepEqual(m.entitySets.ProductText.keys.map((k) => k.name), ['Product', 'Language']);
  assert.deepEqual(m.entitySets.Loop.keys, []);
  assert.equal(m.entitySets.Settings.singleton, true);
  assert.deepEqual(m.entitySets.Settings.properties.map((x) => x.name), ['Product', 'ProductUUID', 'CreatedOn']);
  assert.deepEqual(m.entitySets.Ghost.properties, []);
  assert.deepEqual(m.entitySets.Ghost.navigation, []);

  const ns = 'com.sap.gateway.srvd_a2x.api_product.v0001';
  assert.deepEqual(m.operations[`${ns}.Activate`], {
    name: 'Activate',
    qualifiedName: `${ns}.Activate`,
    kind: 'action',
    bound: true,
    bindingType: 'SAP__self.ProductType',
    parameters: [{ name: 'Force', type: 'Edm.Boolean', nullable: true }],
    returnType: 'SAP__self.ProductType',
    httpMethod: 'POST',
  });
  assert.equal(m.operations[`${ns}.NoParamsBound`].bindingType, undefined);
  assert.equal(m.operations.GetByDate.kind, 'function');
  assert.equal(m.operations.GetByDate.httpMethod, 'GET');
  assert.deepEqual(m.operations.GetByDate.parameters, [{ name: 'Date', type: 'Edm.Date', nullable: false }]);
  assert.equal(m.operations.ResetAll.kind, 'action');
  assert.equal(m.operations.ResetAll.returnType, undefined);
  assert.deepEqual(m.operations.Dangling.parameters, []);
  assert.deepEqual(m.operations.DanglingAction.parameters, []);
  assert.equal(m.operations.DanglingAction.kind, 'action');
  // incomplete declarations do not break parsing
  assert.deepEqual(m.entitySets.NoType.keys, []);
  assert.deepEqual(m.operations.NoFunction.parameters, []);
  assert.deepEqual(m.operations.NoAction.parameters, []);
});

test('parseMetadata - rejects non EDMX and handles empty services', () => {
  assert.throws(() => parseMetadata('<html/>'), /Not an EDMX/);
  const empty = parseMetadata('<edmx:Edmx Version="1.0" xmlns:edmx="x"><edmx:DataServices/></edmx:Edmx>');
  assert.deepEqual(empty.entitySets, {});
  const none = parseMetadata('<edmx:Edmx xmlns:edmx="x"></edmx:Edmx>');
  assert.equal(none.version, 'v2');
});

test('summarize', () => {
  const s = summarize(parseMetadata(V2));
  assert.equal(s.version, 'v2');
  const bp = s.entitySets.find((e) => e.name === 'BusinessPartnerSet');
  assert.deepEqual(bp.properties[0], { name: 'BusinessPartnerID', type: 'Edm.String', label: 'Business Partner ID' });
  assert.deepEqual(s.operations.find((o) => o.id === 'SalesOrder_Confirm'), {
    id: 'SalesOrder_Confirm',
    name: 'SalesOrder_Confirm',
    kind: 'function',
    bound: false,
    httpMethod: 'POST',
    parameters: [{ name: 'SalesOrderID', type: 'Edm.String', nullable: true, mode: 'In' }],
  });
});
