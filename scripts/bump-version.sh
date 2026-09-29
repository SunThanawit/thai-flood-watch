#!/bin/sh
# Stamp local asset URLs in site/index.html so browsers fetch fresh CSS/JS after a deploy.
# Matches only bare file names (src="app.js"), never CDN URLs.
# Usage: bump-version.sh [version]   (defaults to a timestamp)
V=${1:-$(date +%Y%m%d%H%M)}
sed -i -E "s#=\"(styles\.css|[a-z]+\.js)(\?v=[0-9a-z]+)?\"#=\"\1?v=$V\"#g" "$(dirname "$0")/../site/index.html"
