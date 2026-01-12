import mongoose from "mongoose"; 

// Helper to get the model dynamically
const getModel = (modelName) => {
    try {
      return mongoose.model(modelName);
    } catch (error) {
      return mongoose.model(modelName, new mongoose.Schema({}, { strict: false }));
    }
};


const create = async (req, res) => {
    try {
      const { key, model } = req.params;
      const { columns } = req.body;

    if (!model) return res.status(404).json({ error: "Model name required" });
    if (!columns) return res.status(404).json({ error: "Columns required" });

    const Model = getModel(model);

    const documents = await Model.insertMany(columns);

    res.status(201).json({ message: "Created successfully", documents });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
}

const getAll = async (req, res) => {
    try {
      const { key, model } = req.params; 
      if (!model) return res.status(404).json({ error: "Model name required" });

      const Model = getModel(model);
      const documents = await Model.find();
      res.status(200).json({ documents });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
}

const getSingle = async (req, res) => {
    try {
      const { key, model, id } = req.params; 
      if (!model) return res.status(404).json({ error: "Model name required" });

      const Model = getModel(model); 
      const document = await Model.findById(id);
      if (!document) {
        return res.status(404).json({ message: 'document not found' });
      }
      res.status(200).json(document);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
}

const updateDocument = async (req, res) => {
    try {
      const { key, model, id } = req.params;
      const { columns } = req.body;
      if (!model) return res.status(404).json({ error: "Model name required" });

      const Model = getModel(model);
      const updated = await Model.findByIdAndUpdate(id, columns, { new: true });
      if (!updated) {
        return res.status(404).json({ message: 'document not found' });
      }
      res.status(200).json({ message: "Updated successfully", updated });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
}

const deleteDocument = async (req, res) => {
    try {
      const { key, model, id } = req.params;
      if (!model) return res.status(404).json({ error: "Model name required" });

      const Model = getModel(model);
      const document = await Model.findByIdAndDelete(id);
      if (!document) {
        return res.status(404).json({ message: 'document not found' });
      }
      res.status(200).json({ message: "Document Deleted successfully" });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
}

const bulkDeleteDocument = async (req, res) => {
  try {
    const { key, model } = req.params;
    const { startDate, endDate } = req.body;

    if (!model) return res.status(404).json({ error: "Model name required" });
    if (!startDate || !endDate) {
      return res.status(400).json({ message: 'Start date and end date are required' });
    }

    const start = new Date(startDate);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);

    if (isNaN(start) || isNaN(end)) {
      return res.status(400).json({ message: 'Invalid date format' });
    }

    const Model = getModel(model); 
    
    const result = await Model.deleteMany({
      createdAt: { $gte: start, $lte: end },
    });

    res.status(200).json({
      message: `${result.deletedCount} documents deleted successfully.`,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

const getAllCollections = async (req, res) => {
  try {   
    const collections = await mongoose.connection.db.listCollections().toArray();
    const collectionNames = collections.map(col => col.name);  
    return res.json({ collections: collectionNames }); 
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
 

export { create, getAll, getSingle, updateDocument, deleteDocument, bulkDeleteDocument, getAllCollections };