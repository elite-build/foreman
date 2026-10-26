"""Build the bundled people catalog from cached Wikipedia introductions.

Run explicitly with Python; this is never part of workspace creation or app startup.
See docs/workspace-names.md for attribution and adaptation details.
"""
import concurrent.futures
import csv
import io
import json
from pathlib import Path
import re
import time
import threading
import unicodedata
import urllib.parse
import urllib.request
import urllib.error

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / '.workspace-people-cache'
TARGET = 2050
API = 'https://en.wikipedia.org/w/api.php'
HEADERS = {'User-Agent': 'ForemanWorkspacePeople/1.0 (https://github.com/elite-build/foreman)'}
REQUEST_LOCK = threading.Lock()
LAST_REQUEST = 0
SEEDS = '''Nikola Tesla|Isaac Newton|Albert Einstein|Marie Curie|Aristotle|Plato|Socrates|Confucius|Charles Darwin|Alan Turing|Ada Lovelace|Galileo Galilei|Thomas Edison|Archimedes|Srinivasa Ramanujan|C. V. Raman|Satyendra Nath Bose|A. P. J. Abdul Kalam|B. R. Ambedkar|Rabindranath Tagore|Swami Vivekananda|Immanuel Kant|Hannah Arendt|Simone de Beauvoir|Nagarjuna|Laozi|Zhuangzi|Mencius|John Locke|David Hume|Baruch Spinoza|Rene Descartes|Jean-Jacques Rousseau|Voltaire|Friedrich Nietzsche|Karl Marx|John Stuart Mill|Bertrand Russell|Ludwig Wittgenstein|Simone Weil|Albert Camus|Jean-Paul Sartre|Epicurus|Epictetus|Seneca the Younger|Marcus Aurelius|Hypatia|Pythagoras|Euclid|Blaise Pascal|Leonhard Euler|Carl Friedrich Gauss|Michael Faraday|James Clerk Maxwell|Richard Feynman|Niels Bohr|Max Planck|Erwin Schrodinger|Werner Heisenberg|Emmy Noether|Lise Meitner|Rosalind Franklin|Katherine Johnson|Grace Hopper|Carl Sagan|Stephen Hawking|Chien-Shiung Wu|Jane Goodall|Rachel Carson|Louis Pasteur|Gregor Mendel|Dmitri Mendeleev|Antoine Lavoisier|Alexander Fleming|Joseph Lister|Edward Jenner|Avicenna|Averroes|Al-Farabi|Al-Kindi|Al-Ghazali|Ibn Khaldun|Maimonides|Thomas Aquinas|Augustine of Hippo|Soren Kierkegaard|Arthur Schopenhauer|Georg Wilhelm Friedrich Hegel|Michel Foucault|Jacques Derrida|Judith Butler|Martha Nussbaum|Amartya Sen|John Rawls|Karl Popper|Thomas Kuhn|W. E. B. Du Bois|Frantz Fanon|Paulo Freire|bell hooks|Mary Wollstonecraft|Mary Astell|Mary Midgley|G. E. M. Anscombe|Philippa Foot|Susan Sontag|Angela Davis|Wang Yangming|Zhu Xi|Mozi|Xunzi|Sun Tzu|Chanakya|Panini|Adi Shankara|Ramanuja|Madhvacharya|Basava|Kabir|Guru Nanak|Sri Aurobindo|Sarvepalli Radhakrishnan|Thiruvalluvar|Kitaro Nishida|Daisetsu Teitaro Suzuki|Mahatma Gandhi|Martin Luther King Jr.|Frederick Douglass|Ralph Waldo Emerson|Henry David Thoreau|Noam Chomsky|Marshall McLuhan|Ivan Illich|Elinor Ostrom|Adam Smith|John Maynard Keynes|Friedrich Hayek|Thorstein Veblen|Max Weber|Emile Durkheim|W. E. B. Du Bois'''.split('|')


def download(url):
    global LAST_REQUEST
    for attempt in range(4):
        try:
            with REQUEST_LOCK:
                time.sleep(max(0, 0.5 - (time.monotonic() - LAST_REQUEST)))
                LAST_REQUEST = time.monotonic()
            with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=20) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            if error.code not in {429, 503} or attempt == 3:
                raise
            time.sleep(max(5, int(error.headers.get('Retry-After', 5 * 2 ** attempt))))
        except Exception:
            if attempt == 3:
                raise
            time.sleep(5 * 2 ** attempt)


def candidates():
    file = CACHE / 'candidates.json'
    if file.exists():
        return json.loads(file.read_text(encoding='utf-8'))
    data = download('https://raw.githubusercontent.com/Moradnejad/AgeDataset/main/AgeDataset-V1-Part1.csv')
    reader = csv.DictReader(io.StringIO(data.decode('utf-8-sig')))
    field = re.compile(r'\b(scientist|physicist|chemist|mathematician|astronomer|biologist|botanist|zoologist|inventor|geneticist|geologist|microbiologist|biochemist|astrophysicist|statistician|paleontologist|neuroscientist|ecologist|meteorologist|mineralogist|entomologist|philosopher|thinker|economist|sociologist)\b', re.I)
    titles = list(dict.fromkeys(SEEDS + [r['Name'] for r in reader if '\ufffd' not in r['Name'] and field.search(r['Short description'])]))
    file.write_text(json.dumps(titles, ensure_ascii=False), encoding='utf-8')
    return titles


def candidate_identities(titles):
    """Check source identities, avoiding a different person with the same name."""
    file = CACHE / 'candidate-identities.json'
    if file.exists():
        return set(json.loads(file.read_text(encoding='utf-8')))
    data = download('https://raw.githubusercontent.com/Moradnejad/AgeDataset/main/AgeDataset-V1-Part1.csv')
    selected = set(titles)
    reader = csv.DictReader(io.StringIO(data.decode('utf-8-sig')))
    identities = sorted({row['Id'] for row in reader if row['Name'] in selected})
    file.write_text(json.dumps(identities), encoding='utf-8')
    return set(identities)


def fetch_batch(titles):
    key = __import__('hashlib').sha256('|'.join(titles).encode()).hexdigest()[:20]
    file = CACHE / f'{key}.json'
    if file.exists():
        return json.loads(file.read_text(encoding='utf-8'))
    query = urllib.parse.urlencode({'action': 'query', 'prop': 'extracts|pageprops', 'exintro': 1,
                                   'explaintext': 1, 'exlimit': 'max', 'titles': '|'.join(titles),
                                   'redirects': 1, 'format': 'json', 'formatversion': 2})
    time.sleep(0.7)
    try:
        result = json.loads(download(API + '?' + query))
    except Exception:
        print(f'Skipping unavailable batch starting with {titles[0]}', flush=True)
        return []
    pages = result.get('query', {}).get('pages', [])
    file.write_text(json.dumps(pages, ensure_ascii=False), encoding='utf-8')
    return pages


def clean(text):
    # Pronunciations and dates interrupt the short introduction.
    for _ in range(5):
        text = re.sub(r'\([^()]*\)', '', text)
    text = re.sub(r'\[[^\]]*\]', '', text)
    return re.sub(r'\s+', ' ', text).strip()


def contribution(extract, title=''):
    sentences = re.split(r'(?<!\b[A-Z]\.)(?<!\bDr\.)(?<!\bMr\.)(?<!\bSt\.)(?<=[.!?])\s+(?=[A-Z])', clean(extract[:10000]))
    positive = re.compile(r'\b(known for|best-known|contributions? to|discovered|invented|developed|pioneered|formulated|introduced|established|founded|proposed|theory of|theories of|wrote|authored|author of|advocated|argued that|created|originated|pioneer in|pioneer of|research on|research in|work on|work in|credited with)', re.I)
    negative = re.compile(r'\b(died|death|married|wife|husband|children|suicide|buried|executed|convicted|disambiguation|father|mother|brother|sister|descendant|Nazi|Jewish|antisemitic|alleged|accused|authenticity|questioned|rejected|friendship|celebrity|president|award|awarded|prize|medal|interest|interested|honorary|student|pupil|murderer|killer|criminal|secretary|minister|senator|governor|mayor)\b|studied (at|under)|research (fellow|assistant)|was influenced by|found work|own shop|chair .*created|wrote to |member of|established (himself|herself)|named after|wrote prolifically|credited with nearly|serving as', re.I)
    choices = []
    for sentence in sentences:
        if not sentence.endswith('.') or not positive.search(sentence) or negative.search(sentence):
            continue
        # Do not attribute a collaborator's discovery or an eponym to this person.
        opening = ' '.join(sentence.split()[:12]).casefold()
        surname = re.sub(r'\s*\([^)]*\)$', '', title).split()[-1].casefold() if title else ''
        if not re.search(r'\b(he|she|his|her|their)\b', opening) and (not surname or surname not in opening):
            continue
        if re.match(r'(While|With|In|At|As|After|Before|During|According|Owing|Traditional|They|It|These|This|There|However|Also|Later)\b', sentence):
            continue
        if ':' in sentence or ';' in sentence or '"' in sentence:
            continue
        if re.search(r'\b[A-Z]\.$', sentence):
            continue
        if not 7 <= len(sentence.split()) <= 21:
            # Extract a complete short contribution clause rather than a long list of occupations.
            known = re.search(r'\b(?:best )?known for (.+)', sentence, re.I)
            if not known:
                continue
            clause = re.split(r', (?:and |which |where |while |who |but |including |such as )', known[1])[0].rstrip(' .')
            clause = re.sub(r'^(his|her) ', 'their ', clause, flags=re.I)
            sentence = 'They are known for ' + clause + '.'
            if not 7 <= len(sentence.split()) <= 21:
                continue
        score = 3 if re.search(r'known for|best-known|discovered|invented|formulated|originated|created', sentence, re.I) else 1
        choices.append((score, sentence))
    if choices:
        return max(choices, key=lambda item: item[0])[1]
    return None


def slug(text):
    text = text.translate(str.maketrans({'\u00f8': 'o', '\u0142': 'l', '\u00df': 'ss', '\u0111': 'd', '\u00e6': 'ae', '\u0153': 'oe'}))
    text = unicodedata.normalize('NFKD', text).encode('ascii', 'ignore').decode().lower()
    return re.sub('[^a-z]+', '-', text).strip('-')


def friendly_fact(fact):
    # The banner already names the person: omit a repeated name and job-title list.
    known = re.search(r'\b(?:best )?known for (.+)', fact, re.I)
    if known:
        clause = re.sub(r'^(his|her) ', 'their ', known[1], flags=re.I)
        return 'They are known for ' + clause
    return re.sub(r'^.+?\b(?:was|is) an? [^,.]{0,100}?\b(?:chemist|physicist|mathematician|scientist|botanist|biologist|philosopher|inventor|engineer) (?:who |and )(?=discovered|developed|invented|formulated|introduced|established|created|proposed|pioneered|worked|studied|made)', 'They ', fact)


# Familiar names get the short spelling people expect.
ALIASES = {'Nikola Tesla': 'tesla', 'Isaac Newton': 'newton', 'Marie Curie': 'curie',
           'Galileo Galilei': 'galileo', 'C. V. Raman': 'raman', 'Satyendra Nath Bose': 'bose',
           'A. P. J. Abdul Kalam': 'kalam', 'B. R. Ambedkar': 'ambedkar', 'Sri Aurobindo': 'aurobindo',
           'Adi Shankara': 'shankara', 'Seneca the Younger': 'seneca', 'Augustine of Hippo': 'augustine',
           'W. E. B. Du Bois': 'du-bois', 'Al-Farabi': 'alfarabi', 'Al-Kindi': 'alkindi',
           'Al-Ghazali': 'algazali', 'Ibn Khaldun': 'ibn-khaldun', 'Sun Tzu': 'sunzi'}

# Reviewed prose for the examples approved in the conversation.
OVERRIDES = {
    'Nikola Tesla': 'He helped shape how electricity powers our world, pioneering AC motors and power systems.',
    'Isaac Newton': 'He connected falling apples and orbiting planets through his laws of motion and universal gravitation.',
    'Albert Einstein': 'He changed how we understand space, time, and gravity through his theories of relativity.',
    'Marie Curie': 'She pioneered research on radioactivity and helped discover polonium and radium.',
    'Aristotle': 'He explored logic, ethics, and the natural world, shaping how generations of people ask questions.',
    'Plato': 'He explored justice, knowledge, and the ideal society, and founded the Academy in Athens.',
    'Socrates': 'He used thoughtful questions to challenge assumptions and encourage people to examine their lives.',
    'Confucius': 'He taught that learning, kindness, and responsibility help people build a better society.',
    'Alan Turing': 'He helped lay the foundations of computer science and played a key role in wartime codebreaking.',
    'Ada Lovelace': 'She described an algorithm for an early mechanical computer and imagined machines doing more than arithmetic.',
    'Charles Darwin': 'He explained how natural selection shapes the diversity of life on Earth.',
    'Thomas Edison': 'He helped bring practical electric lighting, recorded sound, and motion pictures into everyday life.',
    'Srinivasa Ramanujan': 'He uncovered remarkable patterns in numbers, infinite series, and mathematical functions, often working from extraordinary intuition.',
    'C. V. Raman': 'He discovered how light changes when scattered by matter, giving scientists a new way to study materials.',
    'Satyendra Nath Bose': 'He helped explain how certain particles behave together, laying the foundations of Bose-Einstein statistics.',
    'A. P. J. Abdul Kalam': 'He helped develop Indian space-launch and missile technology and inspired generations of students to pursue science.',
    'B. R. Ambedkar': 'He championed equality and social justice and led the drafting committee for the Constitution of India.',
    'Rabindranath Tagore': 'He used poetry, stories, and education to explore human freedom, creativity, and our connection with the world.',
    'Swami Vivekananda': 'He brought Vedanta and yoga to wider audiences and encouraged education, service, and dialogue between religions.',
    'Nagarjuna': 'He explored how things depend on one another, helping shape Buddhist thinking about emptiness and reality.',
    'Laozi': 'His teachings in the Tao Te Ching invite people to live simply and work with the natural flow of life.',
    'Zhuangzi': 'His playful stories explore freedom, perspective, and the limits of what we think we know.',
    'Mencius': 'He argued that people have the beginnings of goodness within them and that rulers should care for their people.',
    'Mozi': 'He argued for impartial care, practical reasoning, and judging ideas by how much they help people.',
    'Zhu Xi': 'He brought together Confucian ideas about learning, ethics, and the natural world into an influential philosophical system.',
    'Sun Tzu': 'His Art of War explores strategy, preparation, and understanding a situation before taking action.',
    'Chanakya': 'He is traditionally associated with the Arthashastra, a work on government, economics, and statecraft.',
    'Adi Shankara': 'He developed Advaita Vedanta, exploring the idea that the deepest reality is a unified whole.',
    'Kabir': 'His poems challenged religious divisions and encouraged people to seek understanding beyond labels and rituals.',
    'Guru Nanak': 'He founded Sikhism and taught equality, honest work, service, and sharing with others.',
    'Immanuel Kant': 'He explored how we understand the world and why treating people with dignity matters in our moral choices.',
    'John Locke': 'He explored how experience shapes knowledge and argued that government should protect people\'s rights.',
    'David Hume': 'He examined how experience, habit, and emotion shape what we believe and how we make moral judgments.',
    'Baruch Spinoza': 'He explored nature, reason, and human freedom, presenting his philosophy through carefully connected definitions and arguments.',
    'Jean-Jacques Rousseau': 'He explored freedom, education, and the social contract, asking what makes political authority legitimate.',
    'Voltaire': 'He used wit and writing to challenge intolerance and defend freedom of thought and expression.',
    'Friedrich Nietzsche': 'He challenged inherited moral assumptions and explored how people create meaning and values in their lives.',
    'Karl Marx': 'He examined capitalism, class, and labor, shaping generations of debate about economics and society.',
    'John Stuart Mill': 'He argued for individual liberty, women\'s equality, and judging choices by their effects on human well-being.',
    'Bertrand Russell': 'He helped reshape mathematical logic and wrote widely about philosophy, reason, and peace.',
    'Ludwig Wittgenstein': 'He explored how language works and how the words we use shape philosophical problems.',
    'Hannah Arendt': 'She explored political action, freedom, and totalitarianism, asking how people share responsibility for public life.',
    'Simone de Beauvoir': 'She examined freedom and gender, helping shape modern feminism through The Second Sex.',
    'Simone Weil': 'She explored attention, work, and justice, asking how we can respond more thoughtfully to other people\'s suffering.',
    'Albert Camus': 'He explored how people can live with courage and solidarity in a world that offers no easy answers.',
    'Jean-Paul Sartre': 'He explored existentialism, arguing that our choices help shape who we become and carry responsibilities toward others.',
    'Epicurus': 'He taught that friendship, thoughtful choices, and freedom from unnecessary fears can help us live well.',
    'Epictetus': 'He taught that we can live more freely by focusing on our choices rather than what lies outside our control.',
    'Marcus Aurelius': 'His Meditations offer reflections on responsibility, resilience, and meeting everyday challenges with a thoughtful mind.',
    'Hypatia': 'She taught mathematics, astronomy, and philosophy in Alexandria, helping preserve and explain important ideas from the ancient world.',
    'Euclid': 'He organized geometry into a system of definitions and proofs that shaped how mathematics was taught for centuries.',
    'Archimedes': 'He explored geometry, levers, and buoyancy, connecting mathematical reasoning with ingenious practical inventions.',
    'Galileo Galilei': 'He used experiments and telescopic observations to change how people understood motion and the heavens.',
    'Michael Faraday': 'He discovered electromagnetic induction, helping make electric generators and transformers possible.',
    'James Clerk Maxwell': 'He brought electricity, magnetism, and light together in a single mathematical theory.',
    'Richard Feynman': 'He helped explain how light and matter interact and created diagrams that make particle calculations easier to follow.',
    'Emmy Noether': 'She connected symmetry with conservation laws and helped reshape modern algebra.',
    'Lise Meitner': 'She helped explain nuclear fission, showing how splitting an atomic nucleus releases enormous energy.',
    'Rosalind Franklin': 'Her X-ray diffraction research provided crucial evidence for understanding the structure of DNA.',
    'Katherine Johnson': 'Her mathematical calculations helped guide astronauts safely through pioneering American space missions.',
    'Grace Hopper': 'She helped develop early compilers and promoted programming languages that people could read more easily.',
    'Stephen Hawking': 'He explored black holes and the early universe, including the prediction that black holes emit radiation.',
    'Carl Sagan': 'He studied planets and helped millions of people share his curiosity about science and the cosmos.',
    'Chien-Shiung Wu': 'Her experiments showed that nature does not always behave the same way in a mirror, transforming particle physics.',
    'Jane Goodall': 'Her studies of wild chimpanzees changed how we understand their social lives, tool use, and connection with humans.',
    'Rachel Carson': 'Her writing revealed the environmental effects of pesticides and helped inspire the modern environmental movement.',
    'Louis Pasteur': 'He helped establish germ theory and developed pasteurization and vaccines that changed public health.',
    'Gregor Mendel': 'His pea-plant experiments revealed patterns of inheritance that became a foundation of genetics.',
    'Dmitri Mendeleev': 'He organized the periodic table and predicted the properties of elements that had not yet been discovered.',
    'Alexander Fleming': 'He discovered penicillin, opening the door to antibiotics that have saved countless lives.',
    'Edward Jenner': 'He pioneered vaccination against smallpox, helping lay the groundwork for preventing infectious diseases.',
    'Antonie van Leeuwenhoek': 'His carefully crafted microscopes revealed microorganisms, opening a new window into life too small to see.',
    'Charles Babbage': 'He designed programmable mechanical computing machines, helping lay the groundwork for modern computers.',
    'Dennis Ritchie': 'He created the C programming language and helped develop Unix, shaping much of modern computing.',
    'Avicenna': 'He brought together ideas in medicine and philosophy, and his Canon of Medicine guided medical learning for centuries.',
    'Averroes': 'His commentaries on Aristotle helped connect philosophical traditions across the Islamic world and medieval Europe.',
    'Thomas Aquinas': 'He brought Aristotelian philosophy into dialogue with Christian theology, exploring reason, ethics, and faith.',
    'Mary Wollstonecraft': 'She argued that women deserve equal educational opportunities and helped lay the foundations of modern feminism.',
    'W. E. B. Du Bois': 'He combined sociology, history, and activism to examine racism and advocate for civil rights.',
    'Frantz Fanon': 'He explored how colonialism affects people and societies and influenced movements for liberation.',
    'Paulo Freire': 'He developed an approach to education built on dialogue, critical thinking, and learners shaping their own understanding.',
    'bell hooks': 'She explored how race, gender, and class connect and wrote about education, love, and social change.',
    'Elinor Ostrom': 'She showed how communities can successfully manage shared resources through cooperation and locally shaped rules.',
    'Amartya Sen': 'He explored welfare, inequality, and human capabilities, broadening how we think about development and freedom.',
    'John Rawls': 'He explored fairness by asking what rules we would choose without knowing our own place in society.',
    'Karl Popper': 'He argued that scientific ideas should make claims we can test and potentially show to be wrong.',
    'Thomas Kuhn': 'He explored how scientific revolutions reshape the shared assumptions and methods of research communities.',
    'Edsger W. Dijkstra': 'He developed an influential shortest-path algorithm and helped shape structured programming and reasoning about software correctness.',
    'John Wesley Powell': 'He led pioneering scientific expeditions through the Grand Canyon and studied the geology and water resources of the American West.',
    'Raymond Aron': 'He examined industrial society, political ideologies, and international relations, bringing sociology and history into public debate.',
    'Jean-François Lyotard': 'He explored knowledge and culture in postmodern societies, questioning the grand stories used to explain human history.',
}


def build():
    CACHE.mkdir(exist_ok=True)
    titles = candidates()
    identities = candidate_identities(titles)
    people, seen, used = [], set(), set()
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        # Process in stable windows so a repeat run produces the same catalog.
        for start in range(0, len(titles), 300):
            window = titles[start:start + 300]
            batches = [window[i:i + 20] for i in range(0, len(window), 20)]
            results = list(pool.map(fetch_batch, batches))
            pages = [p for result in results for p in result]
            # Keep famous seed figures first when assigning shared surnames.
            order = {title: i for i, title in enumerate(titles)}
            pages.sort(key=lambda p: order.get(p.get('title'), 1000000))
            for page in pages:
                title = page.get('title', '')
                if page.get('missing') or 'disambiguation' in page.get('pageprops', {}):
                    continue
                if title not in SEEDS and title not in OVERRIDES and page.get('pageprops', {}).get('wikibase_item') not in identities:
                    continue
                if page.get('pageid') in seen:
                    continue
                fact = OVERRIDES.get(title) or contribution(page.get('extract', ''), title)
                if not fact:
                    continue
                if title not in OVERRIDES:
                    fact = friendly_fact(fact)
                full_name = re.sub(r'\s*\([^)]*\)$', '', title)
                name = ALIASES.get(title) or slug(full_name.split()[-1])
                if name in used or len(name) < 3 or name in {'jr', 'iii', 'younger', 'elder'}:
                    name = slug(full_name)
                if name in used or not re.fullmatch(r'[a-z]+(?:-[a-z]+)*', name) or len(name) > 48:
                    continue
                seen.add(page['pageid'])
                used.add(name)
                people.append({'name': name, 'fullName': full_name, 'contribution': fact,
                               'source': 'https://en.wikipedia.org/wiki/' + urllib.parse.quote(title.replace(' ', '_')),
                               'revisionSource': 'https://en.wikipedia.org/w/index.php?title=' + urllib.parse.quote(title.replace(' ', '_')) + '&action=history'})
                if len(people) == TARGET:
                    break
            print(f'Checked {min(start + 300, len(titles))} candidates; accepted {len(people)} people', flush=True)
            if len(people) == TARGET:
                break
    if len(people) != TARGET:
        raise RuntimeError(f'Only found {len(people)} suitable introductions')
    people.sort(key=lambda p: p['name'])
    output = ROOT / 'src/shared/workspacePeople.json'
    output.write_text(json.dumps(people, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'Wrote {len(people)} people to {output}', flush=True)


if __name__ == '__main__':
    build()
