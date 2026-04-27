const { Pool, types } = require('pg')
require('dotenv').config()

// pg 預設把 numeric/decimal 回傳為字串，強制轉成 float
types.setTypeParser(1700, v => v == null ? null : parseFloat(v))
// bigint 轉成 number
types.setTypeParser(20, v => v == null ? null : parseInt(v))

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
})

module.exports = { pool }
