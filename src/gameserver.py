import os
import sys
import platform
os.environ['FOR_DISABLE_CONSOLE_CTRL_HANDLER'] = 'T'
# Just disables the warnings
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '2'
os.environ["GRPC_VERBOSITY"] = "ERROR"
os.environ["GLOG_minloglevel"] = "2"
os.environ["TF_ENABLE_ONEDNN_OPTS"] = "0"
import logging
import traceback
import util
# Intil fixed in Keras, this is needed to remove a wrong warning
import warnings
warnings.filterwarnings("ignore")

# Set logging level to suppress warnings
logging.getLogger().setLevel(logging.ERROR)

# Configure absl logging to suppress logs
import absl.logging
# Suppress Abseil logs
absl.logging.get_absl_handler().python_handler.stream = open(os.devnull, 'w')
absl.logging.set_verbosity(absl.logging.FATAL)
absl.logging.set_stderrthreshold(absl.logging.FATAL)

import tensorflow as tf
from nn.opponents import Opponents

import time
import datetime
import asyncio
import websockets
from packaging import version as pkg_version
import argparse
import game
import human
import conf
import functools
import numpy as np
from websockets.exceptions import ConnectionClosedOK, ConnectionClosedError
from sample import Sample
from urllib.parse import parse_qs, urlparse
import json
import scoring
from pbn2ben import load

from colorama import Fore, Back, Style, init
import gc
import psutil
from nn.timing import ModelTimer

version = '0.8.7.6'
init()

# Check websockets version - 15.0+ removed path as handler argument
WEBSOCKETS_VERSION = pkg_version.parse(websockets.__version__)
if WEBSOCKETS_VERSION < pkg_version.parse("15.0"):
    sys.stderr.write(f"{Fore.RED}Error: websockets version {websockets.__version__} is not supported.{Fore.RESET}\n")
    sys.stderr.write(f"{Fore.RED}Please upgrade to websockets >= 15.0: pip install --upgrade websockets{Fore.RESET}\n")
    sys.exit(1)

# Custom function to convert string to boolean
def str_to_bool(value):
    if value.lower() in ['true', '1', 't', 'y', 'yes']:
        return True
    elif value.lower() in ['false', '0', 'f', 'n', 'no']:
        return False
    raise ValueError("Invalid boolean value")

def handle_exception(e):
    sys.stderr.write(f"{str(e)}\n")
    traceback_str = traceback.format_exception(type(e), e, e.__traceback__)
    traceback_lines = "".join(traceback_str).splitlines()
    file_traceback = []
    for line in reversed(traceback_lines):
        if line.startswith("  File"):
            file_traceback.append(line.strip()) 
    if file_traceback:
        sys.stderr.write(f"{Fore.RED}")
        sys.stderr.write('\n'.join(file_traceback)+'\n')
        sys.stderr.write(f"{Fore.RESET}")

def log_memory_usage():
    # Get system memory info
    virtual_memory = psutil.virtual_memory()
    available_memory = virtual_memory.available / (1024 ** 2)  # Convert bytes to MB
    print(f"Available memory before request: {available_memory:.2f} MB")

def get_execution_path():
    # Get the directory where the program is started from either PyInstaller executable or the script
    return os.getcwd()

random = True
#For some strange reason parameters parsed to the handler must be an array
board_no = []
board_no.append(0) 

# Get the path to the config file
config_path = get_execution_path()

parser = argparse.ArgumentParser(description="Game server")
parser.add_argument("--boards", default="", help="Filename for boards")
parser.add_argument("--boardno", default=0, type=int, help="Board number to start from")
parser.add_argument("--config", default=f"{config_path}/config/default.conf", help="Filename for configuration")
parser.add_argument("--opponent", default="", help="Filename for configuration pf opponents")
parser.add_argument("--verbose", type=str_to_bool, default=False, help="Output samples and other information during play")
parser.add_argument("--port", type=int, default=4443, help="Port for appserver")
parser.add_argument("--auto", type=bool, default=False, help="BEN bids and plays all 4 hands")
parser.add_argument("--playonly", type=str_to_bool, default=False, help="Only play, no bidding")
parser.add_argument("--matchpoint", type=str_to_bool, default=None, help="Playing match point")
parser.add_argument("--seed", type=int, default=42, help="Seed for random")

args = parser.parse_args()

configfile = args.config
opponentfile = args.opponent
verbose = args.verbose
port = args.port
auto = args.auto
play_only = args.playonly
matchpoint = args.matchpoint
seed = args.seed
boards = []

np.set_printoptions(precision=2, suppress=True, linewidth=200)

print(f"{Fore.CYAN}{datetime.datetime.now():%Y-%m-%d %H:%M:%S} gameserver.py - Version {version}{Fore.RESET}")
if util.is_pyinstaller_executable():
    print(f"Running inside a PyInstaller-built executable. {platform.python_version()}")
else:
    print(f"Running in a standard Python environment: {platform.python_version()}")

print(f"Python version: {sys.version}{Fore.RESET}")

if sys.platform == 'win32':
    # Print the PythonNet version
    sys.stderr.write(f"PythonNet: {util.get_pythonnet_version()}\n") 
    sys.stderr.write(f"{util.check_dotnet_version()}\n") 

# Try to fetch Keras version or handle older TensorFlow versions
try:
    keras_version = tf.keras.__version__
except AttributeError:
    keras_version = "Not integrated with TensorFlow"
    configfile = configfile.replace("default.conf", "TF1.x/default_tf1x.conf")

# Write to stderr
sys.stderr.write(f"Loading TensorFlow {tf.__version__} - Keras version: {keras_version}\n")
sys.stderr.write(f"NumPy Version : {np.__version__}\n")

configuration = conf.load(configfile)

try:
    if (configuration["models"]['tf_version'] == "2"):
        from nn.models_tf2 import Models
    else:
        # Default to version 1. of Tensorflow
        from nn.models_tf2 import Models
except KeyError:
        # Default to version 1. of Tensorflow
        from nn.models_tf2 import Models

print("Config:", configfile)
if opponentfile != "":
    # Override with information from opponent file
    print("Opponent:", opponentfile)
    configuration.read(opponentfile)
    opponents = Opponents.from_conf(configuration, config_path.replace(os.path.sep + "src",""))
    sys.stderr.write(f"Expecting opponent: {opponents.name}\n")

models = Models.from_conf(configuration, config_path.replace(os.path.sep + "src",""))

# Multi-config support: load all bidding systems into a dict keyed by server ID
# Server IDs: 0=BEN 2/1, 1=BEN SAYC, 2=GIB-BBO, 3=Default(21GF)
SERVER_CONFIGS = {
    '0': f"{config_path}/config/BEN-21GF.conf",
    '1': f"{config_path}/config/BEN-Sayc.conf",
    '2': f"{config_path}/config/GIB-BBO.conf",
    '3': configfile,  # default
}
# servers dict: server_id -> (models, configuration)
servers = {'3': (models, configuration)}  # default already loaded

def load_server_configs():
    """Load additional bidding system configs at startup."""
    base_path = config_path.replace(os.path.sep + "src", "")
    for sid, cpath in SERVER_CONFIGS.items():
        if sid == '3':
            continue  # already loaded
        if not os.path.exists(cpath):
            print(f"  Server {sid}: config not found at {cpath}, skipping")
            continue
        try:
            print(f"  Loading server {sid}: {os.path.basename(cpath)}")
            cfg = conf.load(cpath)
            mdl = Models.from_conf(cfg, base_path)
            servers[sid] = (mdl, cfg)
            print(f"  Server {sid}: {cfg['models'].get('name', 'unnamed')} loaded")
        except Exception as e:
            print(f"  Server {sid}: failed to load - {e}")

print("Loading additional bidding systems...")
load_server_configs()
print(f"Available servers: {list(servers.keys())}")

def get_server(server_id):
    """Return (models, configuration) for a server ID, falling back to default."""
    return servers.get(str(server_id), servers['3'])

# Enable model timing for performance analysis
ModelTimer.enabled = True

if sys.platform != 'win32':
    print("Disabling PIMC/BBA as platform is not win32")
    models.pimc_use_declaring = False
    models.pimc_use_defending = False
    #models.use_bba = False
    #models.consult_bba = False
    #models.use_bba_rollout = False
    #models.use_bba_to_count_aces = False
    #models.use_suitc = False

if models.use_bba:
    print("Using BBA for bidding")
else:
    print("Model:   ", os.path.basename(models.bidder_model.model_path))
    print("Opponent:", os.path.basename(models.opponent_model.model_path))

if matchpoint is not None:
    models.matchpoint = matchpoint

if models.matchpoint:
    print("Matchpoint mode on")
else:
    print("Playing IMPS mode")

if models.use_bba or models.use_bba_to_count_aces or models.consult_bba or models.use_bba_rollout:
    from bba.BBA import BBABotBid
    bot = BBABotBid(None, None ,None, None, None, None, None, None)
    print(f"BBA enabled. Version {bot.version()}")    

if models.use_suitc:
    from suitc.SuitC import SuitCLib
    suitc = SuitCLib(verbose)
    print(f"SuitC enabled. Version {suitc.version()}")

if getattr(models, 'ace_mcts_use_declaring', False) or getattr(models, 'ace_mcts_use_defending', False):
    from ace.ACEMCTS import ACEMCTSDLL
    acemcts = ACEMCTSDLL(None, None, None, None, None, None, None)
    from ace.ACEMCTSDef import ACEMCTSDefDLL
    acemctsdef = ACEMCTSDefDLL(None, None, None, None, None, None, None, None)
    print(f"ACE-MCTS enabled. Version {acemcts.version()}")
    print(f"ACE-MCTS Def enabled. Version {acemctsdef.version()}")

if getattr(models, 'ace_use_declaring', False) or getattr(models, 'ace_use_defending', False):
    from ace.ACE import ACEDLL
    ace = ACEDLL(None, None, None, None, None, None, None)
    from ace.ACEDef import ACEDefDLL
    acedef = ACEDefDLL(None, None, None, None, None, None, None, None)
    print(f"ACE enabled. Version {ace.version()}")
    print(f"ACEDef enabled. Version {acedef.version()}")

if models.pimc_use_declaring or models.pimc_use_defending:
    from pimc.PIMC import BGADLL
    pimc = BGADLL(None, None, None, None, None, None, None)
    from pimc.PIMCDef import BGADefDLL
    pimcdef = BGADefDLL(None, None, None, None, None, None, None, None)
    print(f"PIMC enabled. Version {pimc.version()}")
    print(f"PIMCDef enabled. Version {pimcdef.version()}")

from ddsolver.ddssolver import DDSSolver
dds_max_threads = configuration.getint('dds', 'dds_max_threads', fallback=0)
dds = DDSSolver(max_threads=dds_max_threads)
print(f"DDSSolver enabled. Version {dds.version()} Max threads {dds_max_threads}")

if args.boards:
    filename = args.boards
    file_extension = os.path.splitext(filename)[1].lower()  
    if file_extension == '.ben':
        with open(filename, "r") as file:
            board_no.append(0) 
            lines = file.readlines()  # 
            # Loop through the lines, grouping them into objects
            for i in range(0, len(lines), 2):
                board = {
                    'deal': lines[i].strip(),      
                    'auction': lines[i+1].strip().replace('NT','N')  
                }
                boards.append(board)            
            print(f"{len(boards)} boards loaded from file")
        random = False
    if file_extension == '.pbn':
        with open(filename, "r") as file:
            lines = file.readlines()
            boards = load(lines)
            print(f"{len(boards)} boards loaded from file")
        random = False

if args.boardno:
    print(f"Starting from {args.boardno}")
    board_no[0] = args.boardno -1

if random:
    print("Playing random deals or deals from the client")

def worker(driver):
    print('worker', driver)
    asyncio.new_event_loop().run_until_complete(driver.run())


async def handler(websocket, board_no, seed):
    print('{} Got websocket connection'.format(datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")))

    # In websockets 15.0+, path is accessed via websocket.request.path
    path = websocket.request.path
    parsed_url = urlparse(path)
    query_params = parse_qs(parsed_url.query)

    # Select bidding system from server param
    server_id = query_params.get('server', ['3'])[0]
    srv_models, srv_config = get_server(server_id)

    # Check for multiplayer connection
    room_id = query_params.get('room', [None])[0]
    if room_id:
        seat_char = query_params.get('seat', ['S'])[0]
        human_seats_str = query_params.get('human_seats', [''])[0]
        board_seed = int(query_params.get('board_seed', ['1'])[0])
        mode = query_params.get('mode', ['casual'])[0]
        num_rounds = int(query_params.get('num_rounds', ['0'])[0])
        table_num = int(query_params.get('table', ['1'])[0])
        await mp_handler(websocket, room_id, seat_char, human_seats_str,
                         board_seed, seed, mode, num_rounds, table_num,
                         srv_models, srv_config)
        return

    driver = game.Driver(srv_models, human.WebsocketFactory(websocket, verbose), Sample.from_conf(srv_config, verbose), seed, dds, verbose)
    play_only = False
    driver.human = [False, False, False, False]
    deal = None
    N = query_params.get('N', [None])[0]
    if N: driver.human[0] = True
    E = query_params.get('E', [None])[0]
    if E: driver.human[1] = True
    S = query_params.get('S', [None])[0]
    if S: driver.human[2] = True
    W = query_params.get('W', [None])[0]
    if W: driver.human[3] = True
    H = query_params.get('H', [None])[0]
    if H: driver.human_declare = True
    name = query_params.get('name', [None])[0]
    if name: driver.name = name
    R = query_params.get('R', [None])[0]
    if R: driver.rotate = True
    M = query_params.get('M', [None])[0]
    if M: 
        models.matchpoint = True
    else:
         models.matchpoint = False
    P = query_params.get('P', [None])[0]
    if P == "5":
        play_only = True
    bidding_only_param = query_params.get('bidding_only', ["False"])[0]
    auto_bid_param = query_params.get('auto_bid', [None])[0]
    if auto_bid_param:
        driver.auto_bid = True
    deal = query_params.get('deal', [None])[0]
    board_no_query = query_params.get('board_no')
    board_number = None
    if board_no_query is not None and board_no_query[0] != "null" and board_no_query[0] != "None":
        board_number = int(board_no_query[0]) 
    else:
        if not deal and not board_no[0] > 0:
            board_number = np.random.randint(1, 1000)

    # If deal provided in the URL
    if deal:
        if board_number == None:
            board_number = np.random.randint(1, 1000)
        np.random.seed(board_number)
        split_values = deal[1:-1].replace("'","").split(',')
        rdeal = tuple(value.strip() for value in split_values)
        driver.set_deal(board_number, *rdeal, play_only, bidding_only=bidding_only_param)
        print(f"Board: {board_number} {rdeal} {play_only}")
    else:
        # If random
        if random:
            #Just take a random"
            np.random.seed(board_number)
            rdeal = game.random_deal_board(board_number)
            # example of to use a fixed deal
            # rdeal = ('AK64.8642.Q32.Q6 9.QT973.AT5.KJ94 QT532.J5.KJ974.7 J87.AK.86.AT8532', 'W None')
            print(f"Board: {board_number} {rdeal}")
            driver.set_deal(board_number, *rdeal, False, bidding_only=bidding_only_param)
        else:
            # Select the next from the provided inputfile
            rdeal = boards[board_no[0]]['deal']
            auction = boards[board_no[0]]['auction']
            print(f"{Fore.LIGHTBLUE_EX}Board: {board_no[0]+1} {rdeal}{Fore.RESET}")
            np.random.seed(board_no[0]+1)
            driver.set_deal(board_no[0] + 1, rdeal, auction, play_only, bidding_only=bidding_only_param)

    log_memory_usage()
    ModelTimer.reset()  # Reset timing stats for this request
    try:
        t_start = time.time()
        await driver.run(t_start)

        print(f'{Fore.CYAN}{datetime.datetime.now():%Y-%m-%d %H:%M:%S} Board played in {time.time() - t_start:0.1f} seconds.{Fore.RESET}')
        # Print timing summary for this request
        print(ModelTimer.get_summary())
        if not random and len(boards) > 0:
            board_no[0] = (board_no[0] + 1) % len(boards)
        gc.collect()
        log_memory_usage()

    except (ConnectionClosedOK, ConnectionClosedError, ConnectionAbortedError):
        print('User left')
    except ValueError as e:
        print("Error in configuration - typical the models do not match the configuration.")
        handle_exception(e)
        sys.exit(1)

# === Multiplayer session management ===

mp_sessions = {}  # session_key -> SessionState


def generate_board_seeds(base_seed, count):
    """Generate a reproducible sequence of board seeds from a base seed."""
    rng = np.random.RandomState(base_seed)
    return [int(rng.randint(1, 2000000000)) for _ in range(count)]


def extract_board_result(driver):
    """Extract scoring result from a completed Driver."""
    contract = driver.contract
    if contract is None:
        return {
            'board_no': driver.board_number,
            'contract': None,
            'declarer': None,
            'tricks': 0,
            'score_ns': 0,
            'dict_data': driver.to_dict()
        }
    decl_i = driver.decl_i
    is_vuln = driver.vuln_ns if decl_i in (0, 2) else driver.vuln_ew
    raw_score = scoring.score(contract, is_vuln, driver.tricks_taken)
    score_ns = raw_score if decl_i in (0, 2) else -raw_score
    return {
        'board_no': driver.board_number,
        'contract': contract,
        'declarer': decl_i,
        'tricks': driver.tricks_taken,
        'score_ns': score_ns,
        'dict_data': driver.to_dict()
    }


async def drain_sockets(sockets):
    """Drain any stale messages (e.g. trick confirms, keepalive pings) from all sockets."""
    async def drain_one(ws):
        while True:
            try:
                await asyncio.wait_for(ws.recv(), timeout=0.1)
            except Exception:
                break
    await asyncio.gather(*(drain_one(ws) for ws in sockets.values()))


async def wait_for_next_board(sockets, timeout=600):
    """Wait for all human players to send 'next_board'. Ignores pings and other messages."""
    ready = set()
    needed = set(sockets.keys())
    deadline = time.time() + timeout
    while ready < needed:
        remaining = deadline - time.time()
        if remaining <= 0:
            print("MP: Timeout waiting for next_board from all players")
            break
        # Collect recv tasks for sockets that haven't signaled yet
        tasks = {}
        for si, ws in sockets.items():
            if si not in ready:
                tasks[asyncio.create_task(ws.recv())] = si
        if not tasks:
            break
        done, pending = await asyncio.wait(tasks.keys(), timeout=min(remaining, 30),
                                           return_when=asyncio.FIRST_COMPLETED)
        for t in pending:
            t.cancel()
        for t in done:
            try:
                msg = t.result()
                seat_id = tasks[t]
                if msg == 'next_board':
                    ready.add(seat_id)
                # ignore pings and other messages
            except Exception:
                # socket closed — treat as ready to avoid blocking
                ready.add(tasks[t])


async def broadcast_to_sockets(sockets, msg_dict):
    """Send a JSON message to all sockets, ignoring errors."""
    msg = json.dumps(msg_dict)
    for ws in sockets.values():
        try:
            await ws.send(msg)
        except Exception:
            pass


async def session_loop(session, seed):
    """Run multiple boards in sequence for a multiplayer session."""
    sockets = session['sockets']
    human_seats = session['human_seats']
    mode = session['mode']
    num_rounds = session['num_rounds']
    board_seeds = session['board_seeds']
    max_boards = num_rounds if num_rounds > 0 else 999
    s_models = session.get('srv_models', models)
    s_config = session.get('srv_config', configuration)

    # Send session_start
    await broadcast_to_sockets(sockets, {
        'message': 'session_start',
        'mode': mode,
        'num_rounds': num_rounds
    })

    results = []
    cumulative_ns = 0
    cumulative_ew = 0
    cumulative_imps = 0

    for board_idx in range(min(max_boards, len(board_seeds))):
        if session.get('ended'):
            break

        board_seed = board_seeds[board_idx]

        try:
            # Drain stale messages (trick confirms, keepalive pings) before new board
            await drain_sockets(sockets)

            factory = human.MultiplayerWebsocketFactory(sockets, verbose)
            driver = game.Driver(s_models, factory, Sample.from_conf(s_config, verbose), seed, dds, verbose)
            driver.human = [i in human_seats for i in range(4)]

            np.random.seed(board_seed)
            rdeal = game.random_deal_board(board_seed)
            print(f"MP [{mode}] Board {board_idx + 1}/{max_boards}: seed={board_seed}")
            driver.set_deal(board_seed, *rdeal, False)

            log_memory_usage()
            ModelTimer.reset()
            t_start = time.time()

            # Dual mode: start shadow AI table concurrently with human play
            shadow_task = None
            if mode == 'dual':
                async def run_shadow_table(bs):
                    try:
                        sf = human.SilentFactory()
                        sd = game.Driver(s_models, sf, Sample.from_conf(s_config, verbose), seed, dds, verbose)
                        sd.human = [False, False, False, False]
                        np.random.seed(bs)
                        sr = game.random_deal_board(bs)
                        sd.set_deal(bs, *sr, False)
                        await sd.run(time.time())
                        return extract_board_result(sd)
                    except Exception as e:
                        print(f'MP: Shadow table error: {e}')
                        return None
                shadow_task = asyncio.create_task(run_shadow_table(board_seed))

            await driver.run(t_start)
            elapsed = time.time() - t_start
            print(f'{Fore.CYAN}{datetime.datetime.now():%Y-%m-%d %H:%M:%S} MP Board {board_idx + 1} played in {elapsed:0.1f}s{Fore.RESET}')
            gc.collect()

            result = extract_board_result(driver)
            results.append(result)

            # Accumulate scores
            ns = result['score_ns']
            cumulative_ns += max(0, ns)
            cumulative_ew += max(0, -ns)

            # Dual mode: wait for shadow AI table result
            if shadow_task is not None:
                ai_result = await shadow_task
                if ai_result is not None:
                    diff = ns - ai_result['score_ns']
                    imp_sign = 1 if diff >= 0 else -1
                    imps = scoring.diff_to_imps(diff) * imp_sign
                    cumulative_imps += imps
                    result['ai_result'] = ai_result
                    result['imp'] = imps
                    gc.collect()

                    await broadcast_to_sockets(sockets, {
                        'message': 'dual_table_result',
                        'your_score': ns,
                        'ai_score': ai_result['score_ns'],
                        'ai_contract': ai_result['contract'],
                        'ai_declarer': ai_result['declarer'],
                        'ai_tricks': ai_result['tricks'],
                        'imp': imps,
                        'cumulative_imps': cumulative_imps,
                        'ai_dict': ai_result['dict_data']
                    })

            # Send board_transition (not for the last board)
            is_last = (board_idx == min(max_boards, len(board_seeds)) - 1)
            if session.get('ended'):
                is_last = True

            await broadcast_to_sockets(sockets, {
                'message': 'board_transition',
                'board_idx': board_idx,
                'total_boards': num_rounds,
                'score_ns': ns,
                'cumulative_ns': cumulative_ns,
                'cumulative_ew': cumulative_ew,
                'cumulative_imps': cumulative_imps,
                'has_next': not is_last,
                'mode': mode,
                'contract': result['contract'],
                'tricks': result['tricks'],
                'declarer': result['declarer']
            })

            if not is_last:
                # Wait for all human players to click "Next Board"
                await wait_for_next_board(sockets)

        except (ConnectionClosedOK, ConnectionClosedError, ConnectionAbortedError):
            print(f'MP: Player disconnected during board {board_idx + 1}')
            break
        except Exception as e:
            print(f'MP: Error in board {board_idx + 1}')
            handle_exception(e)
            break

    # Send session_end with all results
    # For match modes, include full analysis data; for casual/dual, summary
    session_end_results = []
    for r in results:
        entry = {
            'board_no': r['board_no'],
            'contract': r['contract'],
            'declarer': r['declarer'],
            'tricks': r['tricks'],
            'score_ns': r['score_ns'],
            'imp': r.get('imp', 0),
            'dict_data': r['dict_data']
        }
        if 'ai_result' in r:
            entry['ai_score'] = r['ai_result']['score_ns']
        session_end_results.append(entry)

    await broadcast_to_sockets(sockets, {
        'message': 'session_end',
        'mode': mode,
        'boards_played': len(results),
        'results': session_end_results,
        'cumulative_ns': cumulative_ns,
        'cumulative_ew': cumulative_ew,
        'cumulative_imps': cumulative_imps
    })


async def match_session_loop(session, seed):
    """Run a match session with two tables playing the same boards."""
    mode = session['mode']
    num_rounds = session['num_rounds']
    board_seeds = session['board_seeds']
    s_models = session.get('srv_models', models)
    s_config = session.get('srv_config', configuration)

    t1_sockets = session['table1_sockets']
    t2_sockets = session['table2_sockets']
    t1_human = session['table1_human_seats']
    t2_human = session['table2_human_seats']
    all_sockets = {**t1_sockets, **{k + 10: v for k, v in t2_sockets.items()}}

    # Send session_start to both tables
    for sockets in [t1_sockets, t2_sockets]:
        await broadcast_to_sockets(sockets, {
            'message': 'session_start',
            'mode': mode,
            'num_rounds': num_rounds
        })

    t1_results = []
    t2_results = []
    cumulative_imps = 0

    for board_idx in range(num_rounds):
        if session.get('ended'):
            break

        board_seed = board_seeds[board_idx]
        print(f"MP [{mode}] Board {board_idx + 1}/{num_rounds}: seed={board_seed}")

        # Run both tables concurrently
        async def run_table(sockets, human_seats, table_name):
            factory = human.MultiplayerWebsocketFactory(sockets, verbose)
            driver = game.Driver(s_models, factory, Sample.from_conf(s_config, verbose), seed, dds, verbose)
            driver.human = [i in human_seats for i in range(4)]
            np.random.seed(board_seed)
            rdeal = game.random_deal_board(board_seed)
            driver.set_deal(board_seed, *rdeal, False)
            t_start = time.time()
            await driver.run(t_start)
            print(f'{Fore.CYAN}  {table_name} done in {time.time() - t_start:0.1f}s{Fore.RESET}')
            return extract_board_result(driver)

        try:
            r1, r2 = await asyncio.gather(
                run_table(t1_sockets, t1_human, 'Table1'),
                run_table(t2_sockets, t2_human, 'Table2')
            )
            gc.collect()

            t1_results.append(r1)
            t2_results.append(r2)

            # IMP calculation
            if mode == 'match2v2':
                # Both tables: NS vs AI-EW. Compare NS scores.
                diff = r1['score_ns'] - r2['score_ns']
            else:
                # 4v4: Team A = Table1 NS + Table2 EW
                # Team A board score = table1_ns + (-table2_ns)
                diff = r1['score_ns'] + (-r2['score_ns'])
            imp_sign = 1 if diff >= 0 else -1
            imps = scoring.diff_to_imps(diff) * imp_sign
            cumulative_imps += imps

            # In match mode, send minimal transition (no scores shown)
            is_last = (board_idx == num_rounds - 1)
            for sockets in [t1_sockets, t2_sockets]:
                await broadcast_to_sockets(sockets, {
                    'message': 'board_transition',
                    'board_idx': board_idx,
                    'total_boards': num_rounds,
                    'has_next': not is_last,
                    'mode': mode
                })

            if not is_last:
                await asyncio.sleep(3)

        except (ConnectionClosedOK, ConnectionClosedError, ConnectionAbortedError):
            print(f'MP Match: Player disconnected during board {board_idx + 1}')
            break
        except Exception as e:
            print(f'MP Match: Error in board {board_idx + 1}')
            handle_exception(e)
            break

    # Session end: send full results to both tables
    session_end_data = {
        'message': 'session_end',
        'mode': mode,
        'boards_played': len(t1_results),
        'cumulative_imps': cumulative_imps,
        'table1_results': [{
            'board_no': r['board_no'], 'contract': r['contract'],
            'declarer': r['declarer'], 'tricks': r['tricks'], 'score_ns': r['score_ns'],
            'dict_data': r['dict_data']
        } for r in t1_results],
        'table2_results': [{
            'board_no': r['board_no'], 'contract': r['contract'],
            'declarer': r['declarer'], 'tricks': r['tricks'], 'score_ns': r['score_ns'],
            'dict_data': r['dict_data']
        } for r in t2_results]
    }
    for sockets in [t1_sockets, t2_sockets]:
        await broadcast_to_sockets(sockets, session_end_data)


async def mp_handler(websocket, room_id, seat_char, human_seats_str,
                     board_seed, seed, mode='casual', num_rounds=0, table_num=1,
                     srv_models=None, srv_config=None):
    """Handle a multiplayer player connection."""
    if srv_models is None:
        srv_models = models
    if srv_config is None:
        srv_config = configuration
    seat_idx = 'NESW'.index(seat_char)
    human_seats = set('NESW'.index(c) for c in human_seats_str)
    is_match = mode in ('match2v2', 'match4v4')
    session_key = room_id

    print(f'{datetime.datetime.now():%Y-%m-%d %H:%M:%S} MP: Player {seat_char} joining room {room_id} ({mode}, table {table_num})')

    if session_key not in mp_sessions:
        max_boards = num_rounds if num_rounds > 0 else 100
        mp_sessions[session_key] = {
            'mode': mode,
            'num_rounds': num_rounds,
            'board_seeds': generate_board_seeds(board_seed, max_boards),
            'ended': False,
            # Single-table (casual/dual)
            'sockets': {},
            'human_seats': human_seats,
            'ready': asyncio.Event(),
            'done': asyncio.Event(),
            # Multi-table (match modes)
            'table1_sockets': {},
            'table2_sockets': {},
            'table1_human_seats': set(),
            'table2_human_seats': set(),
            'table1_ready': asyncio.Event(),
            'table2_ready': asyncio.Event(),
            'srv_models': srv_models,
            'srv_config': srv_config,
        }

    session = mp_sessions[session_key]

    if is_match:
        table_key = f'table{table_num}_sockets'
        human_key = f'table{table_num}_human_seats'
        ready_key = f'table{table_num}_ready'
        session[table_key][seat_idx] = websocket
        session[human_key].update(human_seats)
    else:
        session['sockets'][seat_idx] = websocket

    # Notify this player they're connected
    await websocket.send(json.dumps({
        'message': 'mp_connected',
        'seat': seat_char,
        'room': room_id,
        'mode': mode,
        'table': table_num
    }))

    # Notify others in same table
    if is_match:
        table_sockets = session[f'table{table_num}_sockets']
    else:
        table_sockets = session['sockets']
    for si, ws in table_sockets.items():
        if si != seat_idx:
            try:
                await ws.send(json.dumps({
                    'message': 'mp_player_joined',
                    'seat': seat_char,
                    'connected': ['NESW'[s] for s in sorted(table_sockets.keys())]
                }))
            except Exception:
                pass

    # Check readiness
    if is_match:
        local_human = session[human_key]
        local_sockets = session[f'table{table_num}_sockets']
        if local_human.issubset(set(local_sockets.keys())):
            session[ready_key].set()
        # Wait for BOTH tables
        await session['table1_ready'].wait()
        await session['table2_ready'].wait()
    else:
        if human_seats.issubset(set(session['sockets'].keys())):
            session['ready'].set()
        await session['ready'].wait()

    # Primary handler runs the session loop
    if is_match:
        # For match: primary is lowest seat on table 1
        primary_seat = min(session['table1_human_seats'])
        if table_num == 1 and seat_idx == primary_seat:
            try:
                await match_session_loop(session, seed)
            except (ConnectionClosedOK, ConnectionClosedError, ConnectionAbortedError):
                print(f'MP Match: Player disconnected in room {room_id}')
            except Exception as e:
                print(f'MP Match: Error in room {room_id}')
                handle_exception(e)
            finally:
                session['done'].set()
                await asyncio.sleep(5)
                mp_sessions.pop(session_key, None)
        else:
            try:
                await session['done'].wait()
            except Exception:
                pass
    else:
        # Single-table modes (casual/dual)
        primary_seat = min(session['human_seats'])
        if seat_idx == primary_seat:
            try:
                await session_loop(session, seed)
            except (ConnectionClosedOK, ConnectionClosedError, ConnectionAbortedError):
                print(f'MP: Player disconnected in room {room_id}')
            except Exception as e:
                print(f'MP: Error in room {room_id}')
                handle_exception(e)
            finally:
                session['done'].set()
                await asyncio.sleep(5)
                mp_sessions.pop(session_key, None)
        else:
            try:
                await session['done'].wait()
            except Exception:
                pass


FRONTEND_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'frontend')

MIME_TYPES = {
    '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
    '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
}

async def serve_static(connection, request):
    """Serve static files for HTTP requests; return None to proceed with WebSocket."""
    from websockets.http11 import Response

    # WebSocket upgrade — let it through
    if request.headers.get('Upgrade', '').lower() == 'websocket':
        return None

    path = request.path
    if path == '/' or path == '':
        path = '/menu.html'

    # Strip query string
    if '?' in path:
        path = path.split('?', 1)[0]

    # Strip leading slash and resolve file
    rel = path.lstrip('/')
    filepath = os.path.normpath(os.path.join(FRONTEND_DIR, rel))

    # Security: ensure path stays within FRONTEND_DIR
    if not filepath.startswith(os.path.normpath(FRONTEND_DIR)):
        return Response(403, 'Forbidden', websockets.Headers())

    if not os.path.isfile(filepath):
        return Response(404, 'Not Found', websockets.Headers())

    ext = os.path.splitext(filepath)[1].lower()
    content_type = MIME_TYPES.get(ext, 'application/octet-stream')

    with open(filepath, 'rb') as f:
        body = f.read()

    headers = websockets.Headers([('Content-Type', content_type), ('Content-Length', str(len(body)))])
    return Response(200, 'OK', headers, body)


async def main():
    sys.stderr.write(f"{Fore.CYAN}{datetime.datetime.now():%Y-%m-%d %H:%M:%S} Listening on port: {port}{Fore.RESET}\n")
    sys.stderr.write(f"websockets version: {websockets.__version__}\n")

    start_server = websockets.serve(functools.partial(handler, board_no=board_no, seed=seed), "0.0.0.0", port,
        ping_interval=120,  # send ping every 120 seconds
        ping_timeout=300,  # 300 seconds timeout for pong (AI computation can block event loop)
        close_timeout=60,  # 60 seconds timeout for closing the connection
        process_request=serve_static
        )
    try:
        await start_server
    except OSError as e:
        if e.errno == 10048:
            print("Port is already in use.  - Wait or terminate the process.")
        else:
            raise
    except Exception as e:
        print("Error starting server.")
        handle_exception(e)
        sys.exit(1)

if __name__ == "__main__":
    print(Back.BLACK)
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        loop.run_until_complete(main())
        loop.run_forever()
    except KeyboardInterrupt:
        pass
    except Exception as e:
        handle_exception(e)
        sys.exit(1)
    finally:
        loop.close()
        print(Style.RESET_ALL)