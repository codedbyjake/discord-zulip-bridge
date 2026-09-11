#!/bin/bash
# Prefer the systemd service, fall back to screen when it isn't installed
if systemctl --user cat bridge.service >/dev/null 2>&1; then
	systemctl --user start bridge.service
	echo Bridge started.
	exit 0
fi

if screen -ls | grep -q '\.bridge'; then
	echo Bridge is already running.
	exit 0
fi

/usr/bin/screen -d -m -L -S bridge npm start
echo Bridge started.
