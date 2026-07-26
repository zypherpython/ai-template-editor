import json
import os
import subprocess
import sys
import urllib.request
import urllib.error
import base64


GEMINI_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_URL = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key={GEMINI_KEY}"


def call_direct(prompt: str, image_bytes: bytes) -> str:
    b64 = base64.b64encode(image_bytes).decode()
    body = json.dumps({
        "contents": [{
            "parts": [
                {"text": prompt},
                {"inlineData": {"mimeType": "image/jpeg", "data": b64}}
            ]
        }]
    }).encode()

    req = urllib.request.Request(GEMINI_URL, data=body, headers={"Content-Type": "application/json"})
    resp = urllib.request.urlopen(req, timeout=120)
    data = json.loads(resp.read())
    return data["candidates"][0]["content"]["parts"][0]["text"]


def call_via_powershell(prompt: str, image_bytes: str) -> str:
    win_temp = os.environ.get("USERPROFILE", "C:\\Users\\ss") + "\\Downloads"
    win_prompt = f"{win_temp}\\gemini_prompt.txt"
    win_image = f"{win_temp}\\gemini_image.jpg"
    win_output = f"{win_temp}\\gemini_output.txt"

    prompt_path = f"/mnt/c/Users/ss/Downloads/gemini_prompt.txt"
    image_path = f"/mnt/c/Users/ss/Downloads/gemini_image.jpg"
    output_path = f"/mnt/c/Users/ss/Downloads/gemini_output.txt"

    with open(prompt_path, "w") as f:
        f.write(prompt)
    with open(image_path, "wb") as f:
        f.write(image_bytes)

    ps_script = f"""
$prompt = Get-Content "{win_prompt}" -Raw
$b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("{win_image}"))
$promptEscaped = $prompt -replace '\\\\','\\\\\\\\' -replace '"','\\\\\"'
$json = '{{"contents":[{{"parts":[{{"text":"' + $promptEscaped + '"}},{{"inlineData":{{"mimeType":"image/jpeg","data":"' + $b64 + '"}}}}]}}]}}'
try {{
  $r = Invoke-RestMethod -Uri "{GEMINI_URL}" -Method POST -Body $json -ContentType "application/json" -TimeoutSec 120
  $r.candidates[0].content.parts[0].text | Out-File "{win_output}" -Encoding utf8
}} catch {{
  "GEMINI_ERROR: $($_.Exception.Message)" | Out-File "{win_output}" -Encoding utf8
}}
"""
    subprocess.run(
        ["powershell.exe", "-ExecutionPolicy", "Bypass", "-Command", ps_script],
        capture_output=True, timeout=180
    )

    with open(output_path, "r") as f:
        result = f.read().strip()

    os.remove(prompt_path)
    os.remove(image_path)
    os.remove(output_path)

    return result


if __name__ == "__main__":
    prompt_file = sys.argv[1]
    image_file = sys.argv[2]

    with open(prompt_file, "r") as f:
        prompt = f.read()
    with open(image_file, "rb") as f:
        image_bytes = f.read()

    try:
        result = call_direct(prompt, image_bytes)
        print(result)
    except (urllib.error.URLError, OSError) as e:
        err = str(e).lower()
        if any(word in err for word in ["ssl", "tls", "timeout", "timed out", "connection"]):
            try:
                result = call_via_powershell(prompt, image_bytes)
                if result.startswith("GEMINI_ERROR"):
                    print(result, file=sys.stderr)
                    sys.exit(1)
                print(result)
            except Exception as e2:
                print(f"Bridge failed: {e2}", file=sys.stderr)
                sys.exit(1)
        else:
            print(f"Direct call failed: {e}", file=sys.stderr)
            sys.exit(1)
