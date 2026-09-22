/* Render boot wrapper — forwards to the real server so a root-level
   start command (`node server.js`) works no matter what. */
require("./aura-backend/server.js");
