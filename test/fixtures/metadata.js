'use strict';

// OData V2 EDMX in the shape produced by SAP Gateway (sap: annotations, m:HttpMethod on FunctionImport)
const V2 = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="1.0" xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata" xmlns:sap="http://www.sap.com/Protocols/SAPData">
  <edmx:DataServices m:DataServiceVersion="2.0">
    <Schema Namespace="GWSAMPLE_BASIC" xml:lang="en" sap:schema-version="1" xmlns="http://schemas.microsoft.com/ado/2008/09/edm">
      <EntityType Name="BusinessPartner" sap:content-version="1">
        <Key><PropertyRef Name="BusinessPartnerID"/></Key>
        <Property Name="BusinessPartnerID" Type="Edm.String" Nullable="false" MaxLength="10" sap:label="Business Partner ID" sap:creatable="false" sap:updatable="false"/>
        <Property Name="CompanyName" Type="Edm.String" MaxLength="80" sap:label="Company" sap:filterable="false"/>
        <Property Name="CreatedAt" Type="Edm.DateTime" Precision="7" sap:label="Time Stamp"/>
        <Property Name="Amount" Type="Edm.Decimal" Precision="16" Scale="3"/>
        <Property Name="Weird" Type="Edm.Decimal" Scale="variable" MaxLength="abc"/>
        <NavigationProperty Name="ToSalesOrders" Relationship="GWSAMPLE_BASIC.Assoc_BP_SO" FromRole="FromRole" ToRole="ToRole"/>
      </EntityType>
      <EntityType Name="SalesOrderLineItem">
        <Key><PropertyRef Name="SalesOrderID"/><PropertyRef Name="ItemPosition"/></Key>
        <Property Name="SalesOrderID" Type="Edm.String" Nullable="false"/>
        <Property Name="ItemPosition" Type="Edm.String" Nullable="false"/>
        <Property Name="DeliveryDate" Type="Edm.DateTime"/>
      </EntityType>
      <EntityType Name="Contact">
        <Key><PropertyRef Name="ContactGuid"/></Key>
        <Property Name="ContactGuid" Type="Edm.Guid" Nullable="false"/>
      </EntityType>
      <EntityType Name="Orphan">
        <Key><PropertyRef Name="Missing"/></Key>
      </EntityType>
      <ComplexType Name="CT_Address">
        <Property Name="City" Type="Edm.String"/>
      </ComplexType>
      <Association Name="Assoc_BP_SO">
        <End Type="GWSAMPLE_BASIC.BusinessPartner" Multiplicity="1" Role="FromRole"/>
        <End Type="GWSAMPLE_BASIC.SalesOrderLineItem" Multiplicity="*" Role="ToRole"/>
      </Association>
      <EntityContainer Name="GWSAMPLE_BASIC_Entities" m:IsDefaultEntityContainer="true">
        <EntitySet Name="BusinessPartnerSet" EntityType="GWSAMPLE_BASIC.BusinessPartner" sap:label="Partners" sap:deletable="false"/>
        <EntitySet Name="SalesOrderLineItemSet" EntityType="GWSAMPLE_BASIC.SalesOrderLineItem" sap:creatable="false" sap:updatable="false"/>
        <EntitySet Name="ContactSet" EntityType="GWSAMPLE_BASIC.Contact"/>
        <EntitySet Name="OrphanSet" EntityType="GWSAMPLE_BASIC.Orphan"/>
        <EntitySet Name="UnknownSet" EntityType="OTHER.Unknown"/>
        <FunctionImport Name="SalesOrder_Confirm" ReturnType="GWSAMPLE_BASIC.SalesOrder" EntitySet="SalesOrderSet" m:HttpMethod="POST">
          <Parameter Name="SalesOrderID" Type="Edm.String" Mode="In" MaxLength="10"/>
        </FunctionImport>
        <FunctionImport Name="GetDate" ReturnType="Edm.DateTime">
          <Parameter Name="Day" Type="Edm.DateTime" Mode="In" Nullable="false"/>
        </FunctionImport>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

// OData V4 EDMX as produced by RAP (srvd_a2x) services, with alias, inheritance, bound/unbound operations
const V4 = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:Reference Uri="/sap/opu/odata/IWFND/CATALOGSERVICE;v=2/Vocabularies(TechnicalName='%2FIWBEP%2FVOC_COMMON',Version='0001',SAP__Origin='')/$value">
    <edmx:Include Namespace="com.sap.vocabularies.Common.v1" Alias="Common"/>
  </edmx:Reference>
  <edmx:DataServices>
    <Schema Namespace="com.sap.gateway.srvd_a2x.api_product.v0001" Alias="SAP__self" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EnumType Name="Status"><Member Name="Open" Value="0"/></EnumType>
      <EntityType Name="BaseType">
        <Key><PropertyRef Name="Product"/></Key>
        <Property Name="Product" Type="Edm.String" Nullable="false" MaxLength="40"/>
      </EntityType>
      <EntityType Name="ProductType" BaseType="SAP__self.BaseType">
        <Property Name="ProductUUID" Type="Edm.Guid"/>
        <Property Name="CreatedOn" Type="Edm.Date"/>
        <NavigationProperty Name="_Text" Type="Collection(SAP__self.ProductTextType)"/>
      </EntityType>
      <EntityType Name="ProductTextType">
        <Key><PropertyRef Name="Product"/><PropertyRef Name="Language"/></Key>
        <Property Name="Product" Type="Edm.String" Nullable="false"/>
        <Property Name="Language" Type="Edm.String" Nullable="false"/>
      </EntityType>
      <EntityType Name="LoopA" BaseType="SAP__self.LoopA">
        <Property Name="X" Type="Edm.String"/>
      </EntityType>
      <ComplexType Name="Result"><Property Name="Ok" Type="Edm.Boolean"/></ComplexType>
      <Action Name="Activate" IsBound="true">
        <Parameter Name="_it" Type="SAP__self.ProductType" Nullable="false"/>
        <Parameter Name="Force" Type="Edm.Boolean"/>
        <ReturnType Type="SAP__self.ProductType"/>
      </Action>
      <Action Name="ResetAll">
        <Parameter Name="Reason" Type="Edm.String"/>
      </Action>
      <Function Name="GetByDate">
        <Parameter Name="Date" Type="Edm.Date" Nullable="false"/>
        <ReturnType Type="Collection(SAP__self.ProductType)"/>
      </Function>
      <Function Name="CountBound" IsBound="true">
        <Parameter Name="_it" Type="Collection(SAP__self.ProductType)"/>
        <ReturnType Type="Edm.Int32"/>
      </Function>
      <Function Name="NoParamsBound" IsBound="true">
        <ReturnType Type="Edm.Int32"/>
      </Function>
      <EntityContainer Name="Container">
        <EntitySet Name="Product" EntityType="SAP__self.ProductType">
          <NavigationPropertyBinding Path="_Text" Target="ProductText"/>
        </EntitySet>
        <EntitySet Name="ProductText" EntityType="com.sap.gateway.srvd_a2x.api_product.v0001.ProductTextType"/>
        <EntitySet Name="Loop" EntityType="SAP__self.LoopA"/>
        <EntitySet Name="NoType"/>
        <FunctionImport Name="NoFunction"/>
        <ActionImport Name="NoAction"/>
        <Singleton Name="Settings" Type="SAP__self.ProductType"/>
        <Singleton Name="Ghost" Type="SAP__self.Nope"/>
        <FunctionImport Name="GetByDate" Function="SAP__self.GetByDate"/>
        <FunctionImport Name="Dangling" Function="SAP__self.DoesNotExist"/>
        <ActionImport Name="ResetAll" Action="SAP__self.ResetAll"/>
        <ActionImport Name="DanglingAction" Action="SAP__self.Nope"/>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

module.exports = { V2, V4 };
