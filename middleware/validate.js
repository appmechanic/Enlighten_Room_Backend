import { z } from "zod";

export const validate = (schema) => (req, res, next) => {
    try {

      // Check if the schema requires "address" or "company" fields
      const schemaRequiresParsing = schema.shape?.address || schema.shape?.company;

      if (schemaRequiresParsing) {
        // Parse JSON fields like "address" and "company" if they exist in the schema
        const fieldsToParse = ["address", "company"];
        fieldsToParse.forEach((field) => {
          if (typeof req.body[field] === "string") {
            try {
              req.body[field] = JSON.parse(req.body[field]);
            } catch (error) {
              return res.status(400).json({
                success: false,
                message: `Invalid JSON format for ${field}`,
              });
            }
          }
        });
      }

      req.body = schema.parse(req.body);
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ success: false, message: error.errors[0].message, errors: error.errors });
      }
      next(error);
    }
};
  