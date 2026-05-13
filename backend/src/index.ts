import dotenv from "dotenv";
dotenv.config();

import express from "express";
import typeDefs from "./graphql/typeDefs";
import { ApolloServer } from "@apollo/server";
import resolvers from "./graphql/resolvers";
import { prisma } from "./lib/prisma";
import { expressMiddleware } from "@as-integrations/express5";
import depthLimit from "graphql-depth-limit";
import cors from "cors";

const app = express();
const PORT = Number(process.env.PORT) || 4000;

const server = new ApolloServer({
  typeDefs,
  resolvers,
  validationRules: [depthLimit(5)],
});

app.use(
  cors({
    origin: process.env.CORS_ORIGIN,
  }),
);

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

const main = async () => {
  await server.start();

  app.use(
    "/graphql",
    express.json(),
    expressMiddleware(server, {
      context: async () => ({
        prisma,
      }),
    }),
  );

  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
};

main();
