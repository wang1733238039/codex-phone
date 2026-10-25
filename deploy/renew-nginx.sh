#!/bin/sh
set -eu
case "${RENEWED_LINEAGE:-}" in
    /etc/letsencrypt/live/your-domain.example)
        /usr/sbin/nginx -t
        /usr/bin/systemctl reload nginx
        ;;
esac
