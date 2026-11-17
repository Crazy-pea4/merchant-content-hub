#!/usr/bin/env python3
"""HTTP-only Douyin download and local Chinese hard-subtitle OCR."""
import argparse
from collections import Counter, defaultdict
from difflib import SequenceMatcher
import csv
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlencode, urlsplit

UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'
ROOT = Path(__file__).resolve().parent

def emit(stage, **fields):
    print(json.dumps({'stage': stage, **fields}, ensure_ascii=False), flush=True)

def run(args, timeout=180):
    result = subprocess.run([str(x) for x in args], capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f'{Path(str(args[0])).name} failed: {result.stderr[-1200:]}')
    return result.stdout

def permitted(url, media=False):
    parsed = urlsplit(url)
    host = parsed.hostname or ''
    domains = ('douyin.com', 'iesdouyin.com', 'amemv.com', 'snssdk.com') + (('douyinvod.com', 'idouyinvod.com', 'douyincdn.com') if media else ())
    return parsed.scheme == 'https' and not parsed.username and not parsed.password and parsed.port in (None, 443) and any(host == d or host.endswith('.' + d) for d in domains)

def fetch(url, path, max_bytes, media=False):
    for _ in range(6):
        if not permitted(url, media):
            raise ValueError('下载地址不属于允许的抖音 HTTPS 域名')
        result = json.loads(run(['curl', '-f', '-sS', '--proto', '=https', '--connect-timeout', '10', '--max-time', '90', '--max-filesize', str(max_bytes), '--retry', '0', '-A', UA, '-o', path, '-w', '%{json}', url], 100))
        if result['http_code'] in (301, 302, 303, 307, 308):
            url = result['redirect_url']
            continue
        if result['http_code'] != 200:
            raise RuntimeError(f'抖音返回 HTTP {result["http_code"]}')
        return result['url_effective']
    raise RuntimeError('分享链接重定向次数过多')

def share_url(text):
    match = re.search(r'https://[^\s<>"\x27]+', text)
    if not match:
        raise ValueError('请输入抖音分享链接或含链接的完整分享文字')
    url = match.group().rstrip('，。；）)')
    if urlsplit(url).hostname not in ('v.douyin.com', 'www.douyin.com', 'm.douyin.com', 'www.iesdouyin.com', 'iesdouyin.com') or not permitted(url):
        raise ValueError('请输入有效的抖音移动端分享链接')
    return url

def download(source, output, max_bytes):
    with tempfile.TemporaryDirectory(prefix='douyin-http-') as temp:
        page = Path(temp) / 'response'
        resolved = fetch(source, page, 8 * 1024 * 1024)
        match = re.search(r'/(?:share/)?video/(\d+)', resolved)
        if not match:
            raise RuntimeError('分享链接没有解析出视频 ID，可能是图文或不支持的链接')
        video_id = match.group(1)
        emit('resolving', videoId=video_id)
        endpoint = 'https://api5-normal-c-hl.amemv.com/aweme/v1/feed/?' + urlencode({'aweme_id': video_id, 'aid': '1128'})
        fetch(endpoint, page, 8 * 1024 * 1024)
        data = json.loads(page.read_text())
        item = next((x for x in data.get('aweme_list', []) if str(x.get('aweme_id')) == video_id), None)
        if not item:
            raise RuntimeError('抖音接口没有返回指定视频，可能受到限流或视频不可访问')
        video = item.get('video') or {}
        if item.get('images'):
            raise RuntimeError('暂不支持图文作品，请输入视频分享链接')
        urls = (video.get('play_addr_h264') or video.get('play_addr') or {}).get('url_list') or []
        if not urls:
            raise RuntimeError('该视频没有可下载的视频地址')
        emit('downloading', videoId=video_id)
        media = output / 'video.mp4'
        fetch(urls[0], media, max_bytes, media=True)
        return media, {'videoId': video_id, 'title': item.get('desc', ''), 'resolvedUrl': resolved, 'source': source}

def cjk(text):
    return ''.join(re.findall(r'[\u3400-\u9fff]', text))

def merge_frames(frames, fps, duration):
    groups = []
    step = 1 / fps
    for frame in frames:
        lines = []
        for item in sorted((x for x in frame.get('results', []) if cjk(x['text'])), key=lambda x: -x.get('y', 0)):
            row = next((row for row in lines if abs(row[0].get('y', 0) - item.get('y', 0)) <= .06), None)
            if row is None:
                lines.append([item])
            else:
                row.append(item)
        text = ''.join(item['text'] for row in lines for item in sorted(row, key=lambda x: x.get('x', 0)))
        text = re.sub(r'\s+', '', text)
        if not cjk(text):
            continue
        previous = groups[-1] if groups else None
        gap = frame['t'] - previous['last'] if previous else float('inf')
        exact = previous and cjk(text) in {cjk(t) for t in previous['texts']}
        same = previous and (gap <= step * 1.6 or exact and gap <= step * 2.2) and SequenceMatcher(None, cjk(previous['texts'][0]), cjk(text)).ratio() >= 0.72
        if same:
            previous['texts'].append(text)
            previous['last'] = frame['t']
            previous['frameNumbers'].append(frame['frameNumber'])
        else:
            groups.append({'start': frame['t'], 'last': frame['t'], 'texts': [text], 'frameNumbers': [frame['frameNumber']]})
    cues = []
    for i, group in enumerate(groups, 1):
        counts = Counter(group['texts'])
        cues.append({'id': i, 'start': round(group['start'], 3), 'end': round(min(duration, group['last'] + step), 3), 'text': counts.most_common(1)[0][0], 'variants': [{'text': s, 'frames': n} for s, n in counts.most_common()], 'reviewFrame': group['frameNumbers'][len(group['frameNumbers']) // 2]})
    return cues

def timestamp(seconds):
    ms = round(seconds * 1000)
    return f'{ms // 3600000:02}:{ms // 60000 % 60:02}:{ms // 1000 % 60:02},{ms % 1000:03}'

def export(result_path):
    result = json.loads(result_path.read_text())
    last = 0
    for cue in result['cues']:
        if not (last <= cue['start'] < cue['end'] <= result['duration'] + 0.01) or not cue['text'].strip():
            raise ValueError('字幕时间轴或文本无效')
        last = cue['end']
    (result_path.parent / 'transcript.txt').write_text('\n'.join(x['text'] for x in result['cues']) + '\n')
    (result_path.parent / 'subtitles.srt').write_text('\n\n'.join(f'{i}\n{timestamp(x["start"])} --> {timestamp(x["end"])}\n{x["text"]}' for i, x in enumerate(result['cues'], 1)) + '\n')

def native_ocr(frames_dir, raw_path, fps):
    source = ROOT / 'vision.swift'
    cache = Path(tempfile.gettempdir()) / 'douyin-subtitles-cache'
    cache.mkdir(exist_ok=True)
    binary = cache / ('vision-' + hashlib.sha256(source.read_bytes()).hexdigest()[:16])
    if not binary.exists():
        emit('preparing_ocr')
        run(['swiftc', '-O', '-module-cache-path', cache / 'modules', source, '-o', binary], 180)
    run([binary, frames_dir, raw_path, fps], 900)
    return json.loads(raw_path.read_text())

def tesseract_ocr(frames_dir, raw_path, fps):
    paths = sorted(frames_dir.glob('*.jpg'))
    manifest = frames_dir / 'images.txt'
    manifest.write_text('\n'.join(str(p.resolve()) for p in paths) + '\n')
    rows = csv.DictReader(run(['tesseract', manifest, 'stdout', '-l', 'chi_sim', '--psm', '6', 'tsv'], 900).splitlines(), delimiter='\t', quoting=csv.QUOTE_NONE)
    words = defaultdict(list)
    dimensions = {}
    for row in rows:
        if row.get('level') == '1':
            dimensions[int(row['page_num']) - 1] = (int(row['width']), int(row['height']))
        if row.get('level') == '5' and row.get('text', '').strip():
            words[int(row['page_num']) - 1].append(row)
    frames = []
    for index, path in enumerate(paths):
        lines = defaultdict(list)
        for row in words[index]:
            lines[(row['block_num'], row['par_num'], row['line_num'])].append(row)
        width, height = dimensions.get(index, (1920, 1080))
        results = [{'text': ''.join(x['text'] for x in line), 'x': int(line[0]['left']) / width, 'y': 1 - int(line[0]['top']) / height, 'confidence': sum(float(x['conf']) for x in line) / len(line) / 100} for line in lines.values()]
        frames.append({'frameNumber': index + 1, 't': index / fps, 'results': results})
    raw_path.write_text(json.dumps(frames, ensure_ascii=False))
    return frames

def rapid_ocr(frames_dir, raw_path, fps):
    import cv2
    from rapidocr import RapidOCR
    engine = RapidOCR(params={'Det.limit_type': 'max', 'Det.limit_side_len': 1280})
    frames = []
    for index, path in enumerate(sorted(frames_dir.glob('*.jpg'))):
        image = cv2.imread(str(path))
        result = engine(image)
        results = []
        if result is not None and result.txts is not None:
            for box, text, score in zip(result.boxes, result.txts, result.scores):
                # English lines and low-confidence background detections are not Chinese subtitles.
                if not cjk(text) or float(score) < .72 or len(cjk(text)) / max(1, len(re.sub(r'\s', '', text))) < .5:
                    continue
                results.append({'text': text, 'confidence': float(score), 'x': float(min(p[0] for p in box)) / image.shape[1], 'y': 1 - float(min(p[1] for p in box)) / image.shape[0]})
        frames.append({'frameNumber': index + 1, 't': index / fps, 'results': results})
    raw_path.write_text(json.dumps(frames, ensure_ascii=False))
    return frames

def extract_one(source, output, args):
    started = time.monotonic()
    output.mkdir(parents=True, exist_ok=True)
    result_path = output / 'result.json'
    if args.reuse and result_path.exists():
        existing = json.loads(result_path.read_text())
        if existing.get('status') == 'completed' and existing.get('source') == source and existing.get('fps') == args.fps and existing.get('roi') == args.roi:
            return existing
    if args.local_video:
        media = Path(args.local_video).resolve()
        meta = {'source': str(media), 'videoId': None, 'title': media.stem, 'localVideo': True}
    else:
        media, meta = download(source, output, args.max_mb * 1024 * 1024)
    timings = {'download': round(time.monotonic() - started, 3)}
    probe = json.loads(run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration:stream=width,height,codec_type', '-of', 'json', media], 20))
    duration = float(probe['format']['duration'])
    stream = next(s for s in probe['streams'] if s['codec_type'] == 'video')
    if not math.isfinite(duration) or duration <= 0 or duration > args.max_duration:
        raise ValueError(f'仅支持时长不超过 {args.max_duration:g} 秒的视频')
    emit('sampling', duration=duration)
    stage = time.monotonic()
    frames_dir = output / 'frames'
    frames_dir.mkdir(exist_ok=True)
    for old in frames_dir.glob('*.jpg'):
        old.unlink()
    x, y, w, h = args.roi
    crop = f'crop=trunc(iw*{w}/2)*2:trunc(ih*{h}/2)*2:trunc(iw*{x}/2)*2:trunc(ih*{y}/2)*2'
    run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-i', media, '-vf', f'fps={args.fps},{crop},scale=1920:-2', frames_dir / '%05d.jpg'], 180)
    timings['sampling'] = round(time.monotonic() - stage, 3)
    emit('recognizing')
    stage = time.monotonic()
    raw_path = output / 'ocr-raw.json'
    engine = 'vision' if platform.system() == 'Darwin' and shutil.which('swiftc') else 'rapidocr' if importlib.util.find_spec('rapidocr') else 'tesseract'
    frames = native_ocr(frames_dir, raw_path, args.fps) if engine == 'vision' else rapid_ocr(frames_dir, raw_path, args.fps) if engine == 'rapidocr' else tesseract_ocr(frames_dir, raw_path, args.fps)
    timings['ocr'] = round(time.monotonic() - stage, 3)
    cues = merge_frames(frames, args.fps, duration)
    if not cues:
        raise RuntimeError('裁剪区域内未识别到中文字幕；可调整 ROI，不会用语音翻译补写')
    emit('exporting', cueCount=len(cues))
    review = output / 'review-frames'
    review.mkdir(exist_ok=True)
    for old in review.glob('*.jpg'):
        old.unlink()
    for old in output.glob('review-*.jpg'):
        if re.fullmatch(r'review-\d+\.jpg', old.name):
            old.unlink()
    for cue in cues:
        shutil.copyfile(frames_dir / f'{cue["reviewFrame"]:05}.jpg', review / f'{cue["id"]:05}.jpg')
    run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-framerate', '1', '-i', review / '%05d.jpg', '-vf', 'scale=960:-2,tile=1x12:padding=8:color=white', '-fps_mode', 'vfr', output / 'review-%02d.jpg'], 60)
    timings['total'] = round(time.monotonic() - started, 3)
    result = {**meta, 'status': 'completed', 'reviewStatus': 'unreviewed', 'duration': duration, 'width': stream['width'], 'height': stream['height'], 'bytes': media.stat().st_size, 'engine': engine, 'fps': args.fps, 'roi': args.roi, 'sampledFrames': len(frames), 'timings': timings, 'cues': cues, 'browserUsed': False, 'loginCookiesUsed': False}
    result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    export(result_path)
    emit('completed', result=str(result_path), timings=timings, cueCount=len(cues))
    return result

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('links', nargs='*')
    parser.add_argument('--links-file', type=Path)
    parser.add_argument('--local-video', type=Path)
    parser.add_argument('--export-result', type=Path)
    parser.add_argument('--output', type=Path, default=Path('douyin-output'))
    parser.add_argument('--fps', type=float, default=3)
    parser.add_argument('--roi', default='0,0.65,1,0.32')
    parser.add_argument('--max-duration', type=float, default=600)
    parser.add_argument('--max-mb', type=int, default=128)
    parser.add_argument('--reuse', action='store_true')
    args = parser.parse_args()
    if args.export_result:
        export(args.export_result)
        return
    args.roi = [float(v) for v in args.roi.split(',')]
    if len(args.roi) != 4 or not all(math.isfinite(v) for v in args.roi) or any(v < 0 for v in args.roi) or args.roi[2] <= 0 or args.roi[3] <= 0 or args.roi[0] + args.roi[2] > 1 or args.roi[1] + args.roi[3] > 1:
        parser.error('ROI must be x,y,width,height within 0..1')
    if not math.isfinite(args.fps) or not 1 <= args.fps <= 10 or not 1 <= args.max_mb <= 512 or not math.isfinite(args.max_duration) or not 1 <= args.max_duration <= 3600:
        parser.error('Invalid FPS or media limit')
    inputs = args.links + (args.links_file.read_text().splitlines() if args.links_file else [])
    sources = [str(args.local_video)] if args.local_video else list(dict.fromkeys(share_url(x) for x in inputs if x.strip()))
    if not sources:
        parser.error('Provide Douyin links, --links-file, or --local-video')
    args.output.mkdir(parents=True, exist_ok=True)
    outcomes = []
    for source in sources:
        directory = args.output / hashlib.sha256(source.encode()).hexdigest()[:16]
        try:
            result = extract_one(source, directory, args)
            outcomes.append({'source': source, 'status': 'completed', 'result': str(directory / 'result.json'), 'timings': result['timings']})
        except Exception as exc:
            error = {'source': source, 'status': 'failed', 'error': str(exc)[:1600]}
            directory.mkdir(parents=True, exist_ok=True)
            (directory / 'error.json').write_text(json.dumps(error, ensure_ascii=False, indent=2))
            (directory / 'result.json').write_text(json.dumps(error, ensure_ascii=False, indent=2))
            outcomes.append(error)
            emit('failed', error=error['error'])
    (args.output / 'batch.json').write_text(json.dumps(outcomes, ensure_ascii=False, indent=2) + '\n')
    if any(x['status'] == 'failed' for x in outcomes):
        sys.exit(1)

if __name__ == '__main__':
    main()
