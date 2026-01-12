import express from "express";
import {
  fetchAndStoreCurrencyRates,
  getLatestCurrencyRates,
} from "../controllers/currencyController.js";

const router = express.Router();

// Endpoint to manually fetch and store latest rates
router.post("/fetch-latest", fetchAndStoreCurrencyRates);

// Endpoint to get latest stored rates
router.get("/latest", getLatestCurrencyRates);

export default router;
