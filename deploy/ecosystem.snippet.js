// Add these two entries to /projects/ecosystem.config.js (in the `apps` array),
// then: pm2 reload /projects/ecosystem.config.js --only monitoring --update-env
//       pm2 reload /projects/ecosystem.config.js --only monitoring-agent --update-env
//       pm2 save
//
// Port 16000 is free in the current ecosystem (4000/3010/11000/12000/13000/
// 14000/15000 are taken). Secrets (dashboard password, sessionSecret,
// ingestToken, SMTP) live in /projects/server_monitoring/config.json, which is
// gitignored and is NOT removed by `git reset --hard`, so it survives deploys.

    { name: "monitoring", cwd: "/projects/server_monitoring", script: "npm", args: "start",
      env: { NODE_ENV: "production", PORT: 16000, HOST: "127.0.0.1" }, max_memory_restart: "300M" },

    // The agent for THIS box (central host). On every other monitored server,
    // run an agent too, with CENTRAL_URL + INGEST_TOKEN pointing at central.
    { name: "monitoring-agent", cwd: "/projects/server_monitoring", script: "npm", args: "run agent",
      env: { NODE_ENV: "production" } },
