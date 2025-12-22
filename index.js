require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
// const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
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
    origin: [process.env.CLIENT_DOMAIN],
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
    const ordersCollection = db.collection("orders");
    const usersCollection = db.collection("users");

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

    // get all applications data from db
    app.get("/applications", async (req, res) => {
      const cursor = tutorApplicationCollection.find();
      const result = await cursor.toArray();
      res.send(result);
    });

    // get all applications data from db
    app.get("/applications/:email", async (req, res) => {
      const email = req.params.email;
      const result = await tutorApplicationCollection
        .find({ tutorEmail: email })
        .toArray();
      res.send(result);
    });

    // save a post new application for tutor application
    app.post("/applications", async (req, res) => {
      const application = req.body;
      application.status = "Pending";
      application.appliedAt = new Date();
      const result = await tutorApplicationCollection.insertOne(application);
      res.send(result);
    });

    // DELETE an application
    app.delete("/applications/:id", async (req, res) => {
      const result = await tutorApplicationCollection.deleteOne({
        _id: new ObjectId(req.params.id),
      });
      res.send(result);
    });

    // UPDATE an application (only Pending)
    app.put("/applications/:id", async (req, res) => {
      const { qualifications, experience, expectedSalary } = req.body;
      const result = await tutorApplicationCollection.updateOne(
        { _id: new ObjectId(req.params.id), status: "Pending" },
        { $set: { qualifications, experience, expectedSalary } }
      );
      res.send(result);
    });

    // UPDATE application status (Approve / Reject)
    app.put("/applications/status/:id", async (req, res) => {
      const { status } = req.body; // Expected: "Approved" or "Rejected"
      const result = await tutorApplicationCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { status } }
      );
      res.send(result);
    });

    // 1. Create Checkout Session
    app.post("/create-checkout-session", async (req, res) => {
      try {
        const paymentInfo = req.body;

        if (!paymentInfo?.tutorId || !paymentInfo?.expectedSalary) {
          return res.status(400).json({ error: "Missing payment info" });
        }

        const session = await stripe.checkout.sessions.create({
          payment_method_types: ["card"],
          line_items: [
            {
              price_data: {
                currency: "usd",
                product_data: {
                  name: `Tuition Payment for ${paymentInfo.name}`,
                },
                unit_amount: Math.round(paymentInfo.expectedSalary * 100), // Ensure it's an integer
              },
              quantity: 1,
            },
          ],
          mode: "payment",
          metadata: {
            tutorId: paymentInfo.tutorId,
            tutorEmail: paymentInfo.tutorEmail || "",
          },
          // Pass the session_id to the success page so the frontend can send it back to verify
          success_url: `${process.env.CLIENT_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${process.env.CLIENT_DOMAIN}/dashboard/applied-tutors`,
        });

        res.json({ url: session.url });
      } catch (error) {
        console.error("Stripe checkout error:", error);
        res.status(500).json({ error: "Internal Server Error" });
      }
    });

    // 2. Handle Payment Success (Save to DB)
    app.post("/payment-success", async (req, res) => {
      try {
        const { sessionId } = req.body;

        // Retrieve the session from Stripe to verify payment was actually made
        const session = await stripe.checkout.sessions.retrieve(sessionId);

        if (session.payment_status === "paid") {
          const tutorId = session.metadata.tutorId;

          // Check if this order already exists to prevent duplicates
          const existingOrder = await ordersCollection.findOne({
            transactionId: session.payment_intent,
          });

          if (existingOrder) {
            return res.send({
              message: "Order already recorded",
              insertedId: existingOrder._id,
            });
          }

          // Find tutor details
          const tutor = await tutorApplicationCollection.findOne({
            _id: new ObjectId(tutorId),
          });

          const orderInfo = {
            tutorId: tutorId,
            transactionId: session.payment_intent,
            userEmail: session.customer_details.email,
            status: "Paid",
            userName: session.customer_details.name || "Unknown",
            amount: session.amount_total / 100,
            paidAt: new Date(),
          };

          // 1. Save order to database
          const result = await ordersCollection.insertOne(orderInfo);

          // 2. Update application status to "Approved"
          await tutorApplicationCollection.updateOne(
            { _id: new ObjectId(tutorId) },
            { $set: { status: "Approved" } }
          );

          res.send(result);
        } else {
          res.status(400).send({ message: "Payment not verified" });
        }
      } catch (error) {
        console.error("Success handling error:", error);
        res.status(500).send({ error: "Internal Server Error" });
      }
    });

    // get all orders data from db
    app.get("/my-orders1", async (req, res) => {
      const cursor = ordersCollection.find();
      const result = await cursor.toArray();
      res.send(result);
    });

    // get user payment detail
    app.get("/my-orders", verifyJWT, async (req, res) => {
      // const email = req.params.email;
      const result = await ordersCollection
        .find({ userEmail: req.tokenEmail })
        .toArray();
      res.send(result);
    });

    // get ongoing tuitions details
    app.get("/my-ongoing-tuitions", verifyJWT, async (req, res) => {
      // const email = req.params.email;
      const result = await tutorApplicationCollection
        .find({ tutorEmail: req.tokenEmail })
        .toArray();
      res.send(result);
    });

    // get user payment detail
    app.get("/transaction-history", async (req, res) => {
      const result = await ordersCollection.find().toArray();
      res.send(result);
    });

    // save or update a user in db
    app.get("/users", verifyJWT, async (req, res) => {
      const adminEmail = req.tokenEmail;
      const cursor = usersCollection.find({ email: { $ne: adminEmail } });
      const result = await cursor.toArray();
      res.send(result);
    });

    app.put("/users", async (req, res) => {
      try {
        const user = req.body;
        const query = { email: user?.email };

        // 1. Check if user already exists
        const isExist = await usersCollection.findOne(query);

        if (isExist) {
          // If user exists, only update their last login time
          const updateLogin = {
            $set: { last_loggedIn: new Date().toISOString() },
          };
          const result = await usersCollection.updateOne(query, updateLogin);
          return res.send(result);
        }

        // 2. If user is new, prepare data for insertion
        const options = { upsert: true };
        const updateDoc = {
          $set: {
            ...user,
            created_at: new Date().toISOString(),
            last_loggedIn: new Date().toISOString(),
            timestamp: new Date().toISOString(),
          },
        };

        const result = await usersCollection.updateOne(
          query,
          updateDoc,
          options
        );
        res.send(result);
      } catch (error) {
        console.error("Error in /users PUT:", error);
        res
          .status(500)
          .send({ message: "Internal Server Error", error: error.message });
      }
    });

    // UPDATE USER INFO & ROLE (PATCH)
    app.patch("/users/:id", async (req, res) => {
      const id = req.params.id;
      const filter = { _id: new ObjectId(id) };
      const updatedDoc = {
        $set: {
          name: req.body.name,
          email: req.body.email,
          role: req.body.role,
          status: req.body.status,
          verified: req.body.verified,
        },
      };
      const result = await usersCollection.updateOne(filter, updatedDoc);
      res.send(result);
    });

    //  DELETE USER
    app.delete("/users/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await usersCollection.deleteOne(query);
      res.send(result);
    });

    // get a user's role
    app.get("/user/role", verifyJWT, async (req, res) => {
      // const email = req.params.email;
      const result = await usersCollection.findOne({ email: req.tokenEmail });
      res.send({ role: result?.role });
    });

    // Get ONLY approved tuitions for the public board (for tutors)
    app.get("/tuitions", async (req, res) => {
      const query = { status: "Approved" };
      const result = await tuitionsCollection.find(query).toArray();
      res.send(result);
    });

    // Update Tuition Status (Approve/Reject)
    app.patch("/tuition/status/:id", async (req, res) => {
      const id = req.params.id;
      const { status } = req.body;

      const filter = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: { status: status },
      };

      try {
        const result = await tuitionsCollection.updateOne(filter, updateDoc);
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to update tuition status" });
      }
    });

    // Get all tuitions with Search, Filter, and Sort
    app.get("/all-tuitions", async (req, res) => {
      const { search, filterClass, location, sort } = req.query;

      let query = {};

      // 1. Search by Subject (Case-insensitive)
      if (search) {
        query.subject = { $regex: search, $options: "i" };
      }

      // 2. Filter by Class Level
      if (filterClass) {
        query.classLevel = filterClass;
      }

      // 3. Filter by Location (Case-insensitive)
      if (location) {
        query.location = { $regex: location, $options: "i" };
      }

      // 4. Sorting Logic
      let sortOptions = {};
      if (sort === "budgetLow") sortOptions = { budget: 1 };
      if (sort === "budgetHigh") sortOptions = { budget: -1 };
      if (sort === "newest") sortOptions = { _id: -1 }; // MongoDB IDs include timestamp

      try {
        const result = await tuitionsCollection
          .find(query)
          .sort(sortOptions)
          .toArray();
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Error fetching tuitions" });
      }
    });

    // Get latest 3 tuitions for Homepage
    app.get("/latest-tuitions", async (req, res) => {
      try {
        const result = await tuitionsCollection
          .find({}) // Empty object means no status filter
          .sort({ _id: -1 })
          .limit(3)
          .toArray();
        res.send(result);
      } catch (error) {
        console.error("Error fetching latest tuitions:", error);
        res.status(500).send({ message: "Internal Server Error" });
      }
    });

    app.get("/tuitions-listing", async (req, res) => {
      try {
        const page = parseInt(req.query.page) || 1;
        const size = parseInt(req.query.size) || 10; // Default 10 items per page

        const query = {}; // Add filters here if needed

        // 1. Get total count of items for this query
        const totalCount = await tuitionsCollection.countDocuments(query);

        // 2. Fetch the specific page data
        const result = await tuitionsCollection
          .find(query)
          .sort({ _id: -1 }) // Newest first
          .skip((page - 1) * size)
          .limit(size)
          .toArray();

        res.send({ result, totalCount });
      } catch (error) {
        res.status(500).send({ message: "Error fetching data" });
      }
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
