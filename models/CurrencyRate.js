const mongoose = require("mongoose");

const CurrencyRateSchema = new mongoose.Schema({
  base: { type: String, required: true },
  rates: { type: Map, of: Number, required: true },
  fetchedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("CurrencyRate", CurrencyRateSchema);
