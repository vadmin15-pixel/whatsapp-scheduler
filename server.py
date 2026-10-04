import http.server
import socketserver
import json
import os
import urllib.parse
import base64
import sys
import webbrowser
import re

if hasattr(sys.stdout, 'reconfigure'): sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'): sys.stderr.reconfigure(encoding='utf-8')

PORT = 8000
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, 'data')
PHOTOS_DIR = os.path.join(DATA_DIR, 'photos')
CONFIG_FILE = os.path.join(DATA_DIR, 'config.json')
SITE_DIR = os.path.join(BASE_DIR, 'site')
DDBD_FILES_DIR = os.path.join(SITE_DIR, 'DDBD_files')
ADMIN_DIR = os.path.join(BASE_DIR, 'admin')

os.makedirs(PHOTOS_DIR, exist_ok=True)

DEFAULT_CONFIG = {
  "name": "Sweety",
  "birthdate": "2026-08-05",
  "displayDate": "Aug 5",
  "age": 20,
  "heroMessage": "wishing you a day filled with love, laughter, and all the happiness your heart can hold. May this year bring you endless joy and unforgettable memories. Happy Birthday!",
  "cardTitle": "To My Favorite Person ♥️",
  "cardNote": "Wishing you a birthday that's as bright, beautiful, and wonderful as you are! May all your dreams come true this year.",
  "senderName": "Sidd",
  "captions": ["Pretty ✨", "My Love 🤍", "Sunshine ☀️", "Beautiful 🌸", "Dream Girl 💫", "Queen 👑", "Angel 😇", "Sweetheart 💕"],
  "photos": ["girl.jpg", "girl2.jpg", "girl3.jpg", "girl4.jpg", "girl5.jpg", "girl6.jpg", "girl7.jpg", "girl8.jpg", "girl9.jpg", "girl10.jpg"]
}

def load_config():
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
                cfg = json.load(f)
                for k, v in DEFAULT_CONFIG.items():
                    if k not in cfg: cfg[k] = v
                return cfg
        except Exception: pass
    return DEFAULT_CONFIG.copy()

def save_config(cfg):
    with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)

class BirthdayServerHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        sys.stderr.write("%s - - [%s] %s\n" % (self.address_string(), self.log_date_time_string(), format%args))

    def _send_json(self, data, status=200):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode('utf-8'))

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length)

        if path == '/api/config':
            try:
                data = json.loads(body.decode('utf-8'))
                save_config(data)
                self._send_json({"success": True})
            except Exception as e:
                self._send_json({"success": False, "error": str(e)}, status=400)
            return

        if path == '/api/upload':
            try:
                req_data = json.loads(body.decode('utf-8'))
                filename = req_data.get('filename')
                raw_b64 = req_data.get('data')

                if not filename or not raw_b64:
                    self._send_json({"success": False, "error": "Missing filename or data"}, status=400)
                    return

                filename = os.path.basename(filename)
                if ',' in raw_b64:
                    raw_b64 = raw_b64.split(',', 1)[1]

                img_bytes = base64.b64decode(raw_b64)
                target_path = os.path.join(PHOTOS_DIR, filename)

                with open(target_path, 'wb') as f:
                    f.write(img_bytes)

                cfg = load_config()
                photos = cfg.get('photos', [])
                if filename not in photos:
                    photos.append(filename)
                    cfg['photos'] = photos
                    save_config(cfg)

                self._send_json({"success": True, "filename": filename, "photos": photos})
            except Exception as e:
                self._send_json({"success": False, "error": str(e)}, status=500)
            return

        self.send_response(404)
        self.end_headers()

    def do_DELETE(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        if path == '/api/photos':
            photo_name = query.get('name', [None])[0]
            if photo_name:
                photo_name = os.path.basename(photo_name)
                target_path = os.path.join(PHOTOS_DIR, photo_name)
                if os.path.exists(target_path):
                    try: os.remove(target_path)
                    except Exception: pass
                cfg = load_config()
                photos = cfg.get('photos', [])
                if photo_name in photos:
                    photos.remove(photo_name)
                    cfg['photos'] = photos
                    save_config(cfg)
                self._send_json({"success": True, "photos": photos})
                return
            self._send_json({"success": False, "error": "Missing photo name"}, status=400)
            return

        self.send_response(404)
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == '/api/config':
            self._send_json(load_config())
            return

        if path == '/api/photos':
            files = []
            if os.path.exists(PHOTOS_DIR):
                for f in os.listdir(PHOTOS_DIR):
                    if f.lower().endswith(('.png', '.jpg', '.jpeg', '.gif', '.webp')):
                        files.append(f)
            self._send_json({"photos": files})
            return

        # Admin Panel
        if path in ('/admin', '/admin/'):
            self.serve_file(os.path.join(ADMIN_DIR, 'index.html'), 'text/html; charset=utf-8')
            return
        elif path.startswith('/admin/'):
            rel_path = path[len('/admin/'):]
            self.serve_file(os.path.join(ADMIN_DIR, rel_path))
            return

        # User Uploaded Photos
        if path.startswith('/photos/'):
            photo_name = urllib.parse.unquote(path[len('/photos/'):])
            self.serve_file(os.path.join(PHOTOS_DIR, photo_name))
            return

        # Handle Next.js Chunks Routing (_next/static/chunks/xyz.js -> DDBD_files/xyz.js)
        if '/_next/static/chunks/' in path or '/_next/static/media/' in path:
            filename = os.path.basename(path)
            candidate = os.path.join(DDBD_FILES_DIR, filename)
            if os.path.exists(candidate):
                self.serve_file(candidate)
                return
            # Try appending .js or checking without .download
            if not filename.endswith('.js') and os.path.exists(candidate + '.js'):
                self.serve_file(candidate + '.js')
                return

        # Next.js image optimizer proxy fallback
        if path.startswith('/_next/image'):
            query = urllib.parse.parse_qs(parsed.query)
            url_param = query.get('url', [None])[0]
            if url_param:
                filename = os.path.basename(url_param)
                candidate = os.path.join(DDBD_FILES_DIR, filename)
                if os.path.exists(candidate):
                    self.serve_file(candidate)
                    return

        # Dynamic HTML Pages
        if path in ('/', '/index.html', '/DDBD.html'):
            self.serve_dynamic_html(os.path.join(SITE_DIR, 'DDBD.html'))
            return
        elif path in ('/birthday.html', '/DDBD_files/birthday.html'):
            self.serve_dynamic_html(os.path.join(SITE_DIR, 'DDBD_files', 'birthday.html'))
            return
        elif path in ('/last.html', '/DDBD_files/last.html'):
            self.serve_dynamic_html(os.path.join(SITE_DIR, 'DDBD_files', 'last.html'))
            return

        # General Static File Fallback
        clean_rel = path.lstrip('/')
        target_path = os.path.join(SITE_DIR, urllib.parse.unquote(clean_rel))
        
        # Check if file exists as-is
        if os.path.exists(target_path) and os.path.isfile(target_path):
            self.serve_file(target_path)
            return

        # Check in DDBD_files if filename exists directly
        basename = os.path.basename(path)
        ddbd_candidate = os.path.join(DDBD_FILES_DIR, basename)
        if os.path.exists(ddbd_candidate) and os.path.isfile(ddbd_candidate):
            self.serve_file(ddbd_candidate)
            return
        if os.path.exists(ddbd_candidate + '.js') and os.path.isfile(ddbd_candidate + '.js'):
            self.serve_file(ddbd_candidate + '.js')
            return

        self.send_response(404)
        self.end_headers()

    def serve_dynamic_html(self, filepath):
        if not os.path.exists(filepath):
            self.send_response(404)
            self.end_headers()
            return

        cfg = load_config()
        with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
            html = f.read()

        # Clean up script references from .js.download -> .js
        html = html.replace('.js.download', '.js')

        name = cfg.get('name', 'Sweety')
        date = cfg.get('displayDate', 'Aug 5')
        hero_msg = cfg.get('heroMessage', '')
        card_title = cfg.get('cardTitle', '')
        card_note = cfg.get('cardNote', '')
        captions = cfg.get('captions', [])
        user_photos = cfg.get('photos', [])

        if not user_photos:
            user_photos = [f for f in os.listdir(PHOTOS_DIR) if f.lower().endswith(('.jpg', '.jpeg', '.png', '.webp'))]

        # Text replacements
        html = html.replace('Sweety', name)
        html = html.replace('Aug 5', date)
        if hero_msg:
            html = re.sub(
                r'wishing you a day filled with love, laughter.*?</p>',
                f'{hero_msg}</p>',
                html,
                flags=re.DOTALL
            )

        if card_title:
            html = html.replace("sidd's pipi ♥️", card_title)
            html = html.replace("sidd&#x27;s pipi ♥️", card_title)

        if card_note:
            html = re.sub(
                r'<div class="bubble">.*?</div>',
                f'<div class="bubble">{card_note}</div>',
                html,
                flags=re.DOTALL
            )

        # Image Replacements
        if user_photos:
            def replace_img(match):
                full_match = match.group(0)
                original_filename = match.group(1)
                nums = re.findall(r'\d+', original_filename)
                idx = int(nums[0]) if nums else 0
                selected_photo = user_photos[idx % len(user_photos)]
                return full_match.replace(f'./DDBD_files/{original_filename}', f'/photos/{urllib.parse.quote(selected_photo)}')

            html = re.sub(r'\./DDBD_files/(girl\d*(?:\(\d+\))?\.jpg|heart\.jpg)', replace_img, html)

        # Polaroid Captions
        original_captions = ["Pretty ✨", "My Love 🤍", "Sunshine ☀️", "Beautiful 🌸", "Dream Girl 💫", "Queen 👑", "Cutie 🥹", "Baddie 😎"]
        if captions:
            for i, orig in enumerate(original_captions):
                new_cap = captions[i % len(captions)]
                html = html.replace(orig, new_cap)

        content = html.encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def serve_file(self, filepath, content_type=None):
        if not os.path.exists(filepath) or os.path.isdir(filepath):
            self.send_response(404)
            self.end_headers()
            return

        if content_type is None:
            if filepath.endswith('.html'): content_type = 'text/html; charset=utf-8'
            elif filepath.endswith('.css'): content_type = 'text/css'
            elif filepath.endswith('.js') or filepath.endswith('.download'): content_type = 'application/javascript'
            elif filepath.endswith('.jpg') or filepath.endswith('.jpeg'): content_type = 'image/jpeg'
            elif filepath.endswith('.png'): content_type = 'image/png'
            elif filepath.endswith('.svg'): content_type = 'image/svg+xml'
            elif filepath.endswith('.woff2'): content_type = 'font/woff2'
            elif filepath.endswith('.json'): content_type = 'application/json'
            else: content_type = 'application/octet-stream'

        try:
            with open(filepath, 'rb') as f:
                content = f.read()
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(content)))
            self.end_headers()
            self.wfile.write(content)
        except Exception:
            self.send_response(500)
            self.end_headers()

def main():
    with socketserver.TCPServer(("", PORT), BirthdayServerHandler) as httpd:
        print("="*60)
        print(f"Birthday Generator Server Running on Port {PORT}")
        print(f"Admin Panel:      http://localhost:{PORT}/admin")
        print(f"Website Preview:  http://localhost:{PORT}/")
        print("="*60)
        webbrowser.open(f"http://localhost:{PORT}/admin")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nServer stopped.")

if __name__ == '__main__':
    main()
