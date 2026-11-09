import re
import os

# Folds the stylesheet and the scripts into index.html, so the whole UI arrives
# over a single connection. The adapter's lwIP has room for very few TCP
# segments at once: several large files requested in parallel exhaust it, and
# lwIP answers the extra downloads with a reset - which left the page without
# its scripts.


def read(path):
    with open(path, 'r', encoding='utf-8') as f:
        return f.read()


def inline_css(html, css_path):
    # Look for <link rel="stylesheet" href="css/styles.css">
    # We use a regex to find it, being flexible with whitespace
    pattern = r'<link\s+rel="stylesheet"\s+href="css/styles\.css"\s*>'
    css = read(css_path)
    # A function, not a string: re.sub would read backslashes in the CSS
    # (content: "\2714") as escapes
    new_html = re.sub(pattern, lambda m: f'<style>\n{css}\n</style>', html, count=1)
    if new_html == html:
        print(f"Warning: Could not find stylesheet link")
    else:
        print(f"Inlined {css_path}")
    return new_html


def inline_scripts(html, base_dir):
    # <script defer src="js/x.js"></script> in <head>. Each becomes its own
    # inline <script> at the end of <body>: there it runs once the page is
    # parsed, in the same order, just as defer did. Separate tags keep every
    # file's top level, and piexif's "use strict", to itself.
    pattern = r'[ \t]*<script\s+defer\s+src="(js/[\w.-]+\.js)"\s*>\s*</script>[ \t]*\r?\n?'
    sources = re.findall(pattern, html)
    if not sources:
        print("Warning: Could not find any deferred scripts")
        return html

    blocks = []
    for src in sources:
        code = read(os.path.join(base_dir, src))
        if re.search(r'</script', code, re.IGNORECASE):
            raise SystemExit(f"Error: {src} contains </script and cannot be inlined")
        blocks.append(f'<script>\n{code}\n</script>\n')
        print(f"Inlined {src}")

    html = re.sub(pattern, '', html)
    body_end = html.rfind('</body>')
    if body_end < 0:
        raise SystemExit("Error: index.html has no </body>")
    return html[:body_end] + ''.join(blocks) + html[body_end:]


if __name__ == "__main__":
    base_dir = "fs"
    html_file = os.path.join(base_dir, "index.html")
    css_file = os.path.join(base_dir, "css", "styles.css")

    if os.path.exists(html_file) and os.path.exists(css_file):
        html = read(html_file)
        html = inline_css(html, css_file)
        html = inline_scripts(html, base_dir)
        with open(html_file, 'w', encoding='utf-8', newline='') as f:
            f.write(html)
        print(f"Wrote {html_file}")
    else:
        print("Error: index.html or styles.css not found")
