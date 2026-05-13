const typeDefs = `#graphql
    type Query {
        instrument(id: Int!): Instrument
        kpiMetadata(kpiId: Int!): KpiMetadata
        instruments(limit: Int, offset: Int): [Instrument]
        kpiMetadatas(limit: Int, offset: Int): [KpiMetadata]
    }
    
    type Instrument {
        id: Int!
        name: String!
        ticker: String!
        isin: String
        urlName: String
        sectorId: Int
        marketId: Int
        branchId: Int
        countryId: Int!
        listingDate: String
        stockPriceCurrency: String
        reportCurrency: String
        createdAt: String!
        updatedAt: String!
        stockPrices(limit: Int, offset: Int): [StockPrice]
        kpiValues(limit: Int, offset: Int): [KpiValue]
    }

    type KpiMetadata {
        kpiId: Int!
        nameEn: String!
        nameSv: String!
        format: String
        isString: Boolean!
        # kpiValues: [KpiValue]
    }

    type StockPrice {
        id: Int!
        instrumentId: Int!
        date: String!
        open: Float!
        high: Float!
        low: Float!
        close: Float!
        createdAt: String!
        volume: String!
        # instrument: Instrument
    }

    type KpiValue {
        id: Int!
        instrumentId: Int!
        kpiId: Int!
        reportType: String!
        priceType: String!
        year: Int!
        period: Int
        value: Float
        createdAt: String!
        # instrument: Instrument
        kpi: KpiMetadata
    }
`;

export default typeDefs;
