import axios from "axios";

export const api = axios.create({
  baseURL: "https://apiservice.borsdata.se/v1",
  params: {
    authKey: process.env.BORSDATA_API_KEY,
  },
});
