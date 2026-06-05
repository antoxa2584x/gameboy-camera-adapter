import re
import os

def inline_css(html_path, css_path):
    with open(html_path, 'r', encoding='utf-8') as f:
        html_content = f.read()

    with open(css_path, 'r', encoding='utf-8') as f:
        css_content = f.read()

    # Look for <link rel="stylesheet" href="css/styles.css">
    # We use a regex to find it, being flexible with whitespace
    pattern = r'<link\s+rel="stylesheet"\s+href="css/styles\.css"\s*>'
    replacement = f'<style>\n{css_content}\n</style>'
    
    new_html_content = re.sub(pattern, replacement, html_content)
    
    if html_content == new_html_content:
        print(f"Warning: Could not find stylesheet link in {html_path}")
    else:
        with open(html_path, 'w', encoding='utf-8') as f:
            f.write(new_html_content)
        print(f"Successfully inlined {css_path} into {html_path}")

if __name__ == "__main__":
    base_dir = "fs"
    html_file = os.path.join(base_dir, "index.html")
    css_file = os.path.join(base_dir, "css", "styles.css")
    
    if os.path.exists(html_file) and os.path.exists(css_file):
        inline_css(html_file, css_file)
    else:
        print("Error: index.html or styles.css not found")
