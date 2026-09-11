#!/bin/bash
if systemctl --user cat bridge.service >/dev/null 2>&1; then
	systemctl --user restart bridge.service
	echo Bridge restarted.
	exit 0
fi

./scripts/stop.sh
./scripts/start.sh
echo Bridge restarted.
