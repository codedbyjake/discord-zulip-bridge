#!/bin/bash
if systemctl --user cat bridge.service >/dev/null 2>&1; then
	systemctl --user stop bridge.service
	echo Bridge stopped.
	exit 0
fi

# Send ^C to screen session window
screen -S bridge -X stuff $'\003'
echo Bridge stopped.
