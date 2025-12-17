require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion } = require("mongodb");
const { ObjectId } = require("mongodb");
const admin = require("firebase-admin");
const port = process.env.PORT || 3000;
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf-8"
);
const serviceAccount = JSON.parse(decoded);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const app = express();
// middleware
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "http://localhost:5174",
      "https://b12-m11-session.web.app",
    ],
    credentials: true,
    optionSuccessStatus: 200,
  })
);
app.use(express.json());

// jwt middlewares
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(" ")[1];
  console.log(token);
  if (!token) return res.status(401).send({ message: "Unauthorized Access!" });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.tokenEmail = decoded.email;
    console.log(decoded);
    next();
  } catch (err) {
    console.log(err);
    return res.status(401).send({ message: "Unauthorized Access!", err });
  }
};

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});
async function run() {
  try {
    const db = client.db("tuitionsDB");

    const tuitionsCollection = db.collection("tuitions");
    const tutorApplicationCollection = db.collection("applications");

    // Save a post new tuition data in db
    app.post("/tuitions", async (req, res) => {
      const tuitionData = req.body;
      const result = await tuitionsCollection.insertOne(tuitionData);
      res.send(result);
    });

    // get all tuitions data from db
    app.get("/tuitions", async (req, res) => {
      const cursor = tuitionsCollection.find();
      const result = await cursor.toArray();
      res.send(result);
    });

    // DELETE tuition by ID
    app.delete("/tuitions/:id", async (req, res) => {
      const id = req.params.id;

      const query = { _id: new ObjectId(id) };
      const result = await tuitionsCollection.deleteOne(query);

      res.send(result);
    });

    // UPDATE tuition by ID
    app.put("/tuitions/:id", async (req, res) => {
      const id = req.params.id;
      const updatedData = req.body;

      const query = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {
          subject: updatedData.subject,
          classLevel: updatedData.classLevel,
          location: updatedData.location,
          budget: updatedData.budget,
        },
      };

      const result = await tuitionsCollection.updateOne(query, updateDoc);
      res.send(result);
    });

    // save a post new application for tutor application
    app.post("/applications", async (req, res) => {
      const application = req.body;
      const result = await tutorApplicationCollection.insertOne(application);
      res.send(result);
    });

    // update tutor application by id on set status in pending
    app.patch("/applications/:id", async (req, res) => {
      const id = req.params.id;
      const { status } = req.body;

      const result = await tutorApplicationCollection.updateOne({ _id: new ObjectId(id) }, { $set: { status } });

      res.send(result);
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Hello from Server..");
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
