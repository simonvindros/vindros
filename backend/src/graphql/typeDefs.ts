const typeDefs = `#graphql
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
        # stockPrices: StockPrice
        # kpiValues: KpiValue
    }   

    type Query {
        instrument(id: Int!): Instrument
    }
`;

export default typeDefs;
