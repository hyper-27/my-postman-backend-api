// Load environment variables from .env file at the very beginning
require('dotenv').config();
//mongodb+srv://anuj-27:<db_password>@cluster0.2yxrbuu.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose'); // <--- THIS LINE IS CRITICAL
const bcrypt = require('bcryptjs'); // <--- NEW
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
// app.use(cors()); // OLD line

app.use(cors({ // <--- NEW: CORS configuration for production
    origin: 'YOUR_FRONTEND_PROD_URL', // Replacing with  actual frontend URL (e.g., https://my-postman-clone.vercel.app)
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    credentials: true // Allow cookies/authorization headers
}));
app.use(express.json());


// --- MongoDB Connection ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ Connected to MongoDB Atlas successfully!'))
    .catch(err => console.error('❌ MongoDB connection error:', err.message));

// --- MongoDB Schema and Model ---
// Define the structure for storing saved requests
const requestSchema = new mongoose.Schema({
    url: { type: String, required: true },
    method: { type: String, required: true },
    headers: { type: Object, default: {} },
    body: { type: Object, default: {} },
    responseStatus: Number,
    responseHeaders: { type: Object, default: {} },
    responseData: { type: Object, default: {} },
    timestamp: { type: Date, default: Date.now },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true } // <--- NEW: Link to User
});
const SavedRequest = mongoose.model('SavedRequest', requestSchema);

// --- MongoDB Schema and Model for Users ---
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    // You can add more fields like email, createdAt etc.
});

// Pre-save hook to hash password before saving a new user
userSchema.pre('save', async function(next) {
    if (this.isModified('password')) {
        const salt = await bcrypt.genSalt(10);
        this.password = await bcrypt.hash(this.password, salt);
    }
    next();
});

// Method to compare password for login
userSchema.methods.comparePassword = async function(candidatePassword) {
    return bcrypt.compare(candidatePassword, this.password);
};

const User = mongoose.model('User', userSchema);

// --- Authentication Middleware ---
const auth = (req, res, next) => {
    // Get token from header
    const token = req.header('Authorization');

    // Check if not token
    if (!token) {
        return res.status(401).json({ message: 'No token, authorization denied' });
    }

    // Extract token from "Bearer <token>" format
    const tokenValue = token.split(' ')[1];
    if (!tokenValue) {
        return res.status(401).json({ message: 'Token format invalid' });
    }

    try {
        // Verify token
        const decoded = jwt.verify(tokenValue, process.env.JWT_SECRET);

        // Add user from payload
        req.user = decoded.user; // Now req.user.id will contain the user's ID
        next(); // Proceed to the next middleware/route handler
    } catch (err) {
        console.error('❌ Token verification failed:', err.message);
        res.status(401).json({ message: 'Token is not valid' });
    }
};

// --- API Routes ---

// 1. Proxy Endpoint: Receives request from frontend, makes external API call, and saves to DB
// Change from: app.post('/api/proxy', async (req, res) => {
app.post('/api/proxy', auth, async (req, res) => { // <--- ADD 'auth' middleware
    const { url, method, headers, body } = req.body;

    if (!url || !method) {
        return res.status(400).send({ error: 'URL and Method are required.' });
    }

    try {
        const response = await axios({
            method: method.toLowerCase(),
            url: url,
            headers: headers,
            data: body,
            validateStatus: function (status) {
                return true;
            },
        });

        // --- Save the request details and response to MongoDB ---
        const newSavedRequest = new SavedRequest({
            url: url,
            method: method,
            headers: headers,
            body: body,
            responseStatus: response.status,
            responseHeaders: response.headers,
            responseData: response.data,
            user: req.user.id // <--- NEW: Save the user ID with the request
        });
        await newSavedRequest.save(); // Save to database

        // Send the external API's response back to the frontend
        res.status(response.status).send({
            status: response.status,
            headers: response.headers,
            data: response.data
        });

    } catch (error) {
        console.error("❌ Proxy request failed:", error.message);
        let errorMessage = "An unknown error occurred while proxying the request.";
        if (error.response) {
            errorMessage = `External API Error: ${error.response.status} - ${JSON.stringify(error.response.data)}`;
            res.status(error.response.status).send({ error: errorMessage, details: error.response.data });
        } else if (error.request) {
            errorMessage = "No response received from the external API (network error or API unreachable).";
            res.status(500).send({ error: errorMessage });
        } else {
            errorMessage = `Error setting up request: ${error.message}`;
            res.status(500).send({ error: errorMessage });
        }
    }
});


// 2. History Endpoint: Fetches previously saved requests from the database
app.get('/api/history', auth, async (req, res) => { // <--- ADD 'auth' middleware
    try {
        // Fetch the last 10 saved requests for the CURRENT user, sorted by timestamp
        const history = await SavedRequest.find({ user: req.user.id }) // <--- NEW: Filter by user ID
                                          .sort({ timestamp: -1 })
                                          .limit(10);
        res.status(200).send(history);
    } catch (error) {
        console.error("❌ Failed to fetch history:", error.message);
        res.status(500).send({ error: "Failed to retrieve history." });
    }
});

// --- User Authentication Routes ---

// 3. Register User
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;

    try {
        // Check if user already exists
        let user = await User.findOne({ username });
        if (user) {
            return res.status(400).json({ message: 'User already exists' });
        }

        // Create new user
        user = new User({ username, password });
        await user.save(); // Password will be hashed by the pre-save hook

        // Generate JWT Token
        const payload = { user: { id: user.id } };
        const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1h' });

        res.status(201).json({ message: 'User registered successfully', token });

    } catch (error) {
        console.error('❌ Registration error:', error.message);
        res.status(500).json({ message: 'Server error during registration' });
    }
});

// 4. Login User
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;

    try {
        // Check if user exists
        const user = await User.findOne({ username });
        if (!user) {
            return res.status(400).json({ message: 'Invalid credentials' });
        }

        // Compare password
        const isMatch = await user.comparePassword(password);
        if (!isMatch) {
            return res.status(400).json({ message: 'Invalid credentials' });
        }

        // Generate JWT Token
        const payload = { user: { id: user.id } };
        const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1h' });

        res.json({ message: 'Logged in successfully', token });

    } catch (error) {
        console.error('❌ Login error:', error.message);
        res.status(500).json({ message: 'Server error during login' });
    }
});

// --- Start the Server ---
app.listen(PORT, () => {
    console.log(`🚀 Backend server listening on http://localhost:${PORT}`);
    console.log(`Database connected: ${process.env.MONGO_URI ? 'Yes' : 'No (MONGO_URI not set!)'}`);
});

