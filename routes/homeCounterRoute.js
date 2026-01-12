import { Router } from "express";
import {
  upsertCounters,
  listCounters,
  getCounter,
  deleteCounter,
} from "../controllers/homeCounterController.js";

const router = Router();

router.put("/counters", upsertCounters); // create-or-update many (or one) by key
router.get("/counters", listCounters); // list all
router.get("/counters/:key", getCounter); // get one by key
router.delete("/counters/:key", deleteCounter); // delete by key

export default router;
