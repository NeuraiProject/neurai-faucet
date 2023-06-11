Neurai Faucet
=================

What is it?
----
Fully customizable Faucet built on NodeJS, Express 3, and Bootstrap.

Based on original code from [cryptofaucet-node](https://github.com/clapyohands/cryptofaucet-node) and Antares version in [radiant-faucet](https://github.com/Antares-RXD/radiant-faucet)

Configuration
----
Set global configuration options in config.js 

Installation
----

    npm install
    
This will install all the necessary dependencies
    
Run
----

    node app.js
    
Or using [forever](https://www.npmjs.com/package/forever):

    forever start app.js

Or with *systemd* (Linux only):

```
[Unit]
Description=Neurai Faucet Daemon
After=network.target

[Service]
WorkingDirectory=/PATH_TO_FAUCET
User=root
Group=root
Type=simple
ExecStart=node /PATH_TO_FAUCET/app.js
Restart=on-failure
RestartSec=5s
PrivateTmp=true

[Install]
WantedBy=multi-user.target

```
