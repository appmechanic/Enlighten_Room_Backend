import express from 'express';
import { 
  createPayPalOrder, 
  capturePayPalOrder,
  initializePayPalPricing,
  initializePlanPayPalPricing,
  syncStripePlansToPayPal
} from '../controllers/paypalController.js';
import auth_key_header from '../middleware/auth_key_header.js';
import auth_token from '../middleware/auth_token.js';
import auth_admin from '../middleware/auth_admin.js';

const router = express.Router();

// Create PayPal order
router.post('/order', auth_key_header, auth_token, createPayPalOrder);

// Capture PayPal order
router.post('/capture', auth_key_header, auth_token, capturePayPalOrder);

// Initialize PayPal pricing for all plans (admin only)
router.post('/init-pricing', auth_key_header, auth_token, auth_admin, initializePayPalPricing);

// Initialize PayPal pricing for a specific plan (admin only)
router.post('/init-plan/:planId', auth_key_header, auth_token, auth_admin, initializePlanPayPalPricing);
router.get('/paypal/sync-plans', syncStripePlansToPayPal); // TEMP: allow GET for testing
export default router;
