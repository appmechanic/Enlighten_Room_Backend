import express from "express";
const router = express.Router();  
import auth_key_param from "../middleware/auth_key_param.js";
import auth_token from "../middleware/auth_token.js"; 
import { create, getAll, getSingle, updateDocument, deleteDocument, bulkDeleteDocument, getAllCollections } from "../controllers/crud.js";


// Create (POST)
router.post('/:key/:model/create', auth_key_param, auth_token, create);

// Get all (GET)
router.get('/:key/:model/get-all', auth_key_param, auth_token, getAll);

// Get by ID (GET)
router.get('/:key/:model/get-single/:id', auth_key_param, auth_token, getSingle);

// Update by ID (PUT)
router.put('/:key/:model/update/:id', auth_key_param, auth_token, updateDocument);

// Delete by ID (DELETE)
router.delete('/:key/:model/delete/:id', auth_key_param, auth_token, deleteDocument);

// Bulk Delete (DELETE)
router.delete('/:key/:model/bulk-delete', auth_key_param, auth_token, bulkDeleteDocument);

// Get List of DB Collections (GET)
router.get('/:key/all-collections', auth_key_param, auth_token, getAllCollections);

export default router;