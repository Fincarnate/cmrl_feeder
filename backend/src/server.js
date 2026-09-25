require('dotenv').config();         //read from .env file
const express = require('express');
const app = express();              //start express server
const PORT = process.env.PORT || 5000;   //either .env or 5000

app.get('/', (req, res) => {                            //testing root route here
    res.json({ 
        message: "CMRL feeder backend is running" 
    });
});
app.listen(PORT, () => {
  console.log(`SERVER is running. :D the port is ${PORT}`);
});