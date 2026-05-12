const express = require("express");

const app = express();

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("Cleanify Reporting Agent funcionando ✅");
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "cleanify-reporting-agent"
  });
});

app.listen(PORT, () => {
  console.log(`Cleanify Reporting Agent escuchando en puerto ${PORT}`);
});
