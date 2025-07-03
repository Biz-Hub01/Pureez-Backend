require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const cors = require('cors');
const mpesaRoutes = require('./routes/mpesa');

const app = express();
const PORT = process.env.PORT || 8081;

// Enhanced CORS middleware
app.use(cors({
  origin: [
    'http://localhost:8080',
    'https://your-production-domain.com'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Routes
app.use('/api/mpesa', mpesaRoutes);

// Health check
app.get('/', (req, res) => {
  res.send('Declutter Backend Running');
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});