const axios = require("axios");
const CurrencyRate = require("../models/CurrencyRate");
require("dotenv").config();

// Fetch latest rates from Open Exchange Rates (API key required)
async function fetchAndStoreCurrencyRates(req, res) {
  try {
    const APP_ID = process.env.OPEN_EXCHANGE_RATES_APP_ID;
    if (!APP_ID) {
      return res.status(500).json({
        success: false,
        message:
          "Missing Open Exchange Rates API key in environment variable OPEN_EXCHANGE_RATES_APP_ID",
      });
    }
    const url = `https://openexchangerates.org/api/latest.json?app_id=${APP_ID}`;
    const response = await axios.get(url);
    if (!response.data || !response.data.rates) {
      console.error("No rates found in response:", response.data);
      return res.status(500).json({
        success: false,
        message: "No rates found in API response",
        error: response.data,
      });
    }
    // Open Exchange Rates always returns USD as base for free tier
    const base = "USD";
    const rates = response.data.rates;
    const date = response.data.timestamp
      ? new Date(response.data.timestamp * 1000)
      : new Date();
    // Filter for needed currencies
    const needed = ["EUR", "CNY", "CAD", "HKD", "JPY", "AUD"];
    const filteredRates = {};
    for (const code of needed) {
      filteredRates[code] = rates[code] !== undefined ? rates[code] : null;
    }
    // Upsert: update if exists, create if not
    const updated = await CurrencyRate.findOneAndUpdate(
      { base },
      { rates: filteredRates, fetchedAt: date },
      { upsert: true, new: true }
    );
    console.log("Currency rates upserted:", updated);
    res
      .status(200)
      .json({ success: true, message: "Rates updated", rates: filteredRates });
  } catch (error) {
    console.error("Error fetching/storing currency rates:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch rates",
      error: error.message,
    });
  }
}

// Get latest stored rates
async function getLatestCurrencyRates(req, res) {
  try {
    const latest = await CurrencyRate.findOne().sort({ fetchedAt: -1 });
    if (!latest)
      return res
        .status(404)
        .json({ success: false, message: "No rates found" });
    res.status(200).json({
      success: true,
      rates: latest.rates,
      base: latest.base,
      fetchedAt: latest.fetchedAt,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to get rates",
      error: error.message,
    });
  }
}

module.exports = {
  fetchAndStoreCurrencyRates,
  getLatestCurrencyRates,
};
