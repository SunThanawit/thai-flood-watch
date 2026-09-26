#!/bin/sh
# Stamp asset URLs in site/index.html so browsers fetch fresh CSS/JS after a deploy.
V=$(date +%Y%m%d%H%M)
sed -i -E "s#(styles\.css|app\.js|community\.js)(\?v=[0-9]+)?\"#\1?v=$V\"#g" "$(dirname "$0")/../site/index.html"
