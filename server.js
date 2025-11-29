// server.js — tiny web server so Render never spins down
const express = require("express");
const app = express();

app.get("/", (req, res) => res.send("1G Vault Caller Running 24/7"));
app.get("/ping", (req, res) => res.send("alive"));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Web server up — bot immortal"));
