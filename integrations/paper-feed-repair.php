<?php

declare(strict_types=1);

require dirname(__DIR__, 2) . '/constants.php';
require LIB_PATH . '/lib_rss.php';

header("Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; sandbox");
header('Content-Type: application/json; charset=UTF-8');
header('X-Content-Type-Options: nosniff');

function paperApiHeader(string $name): string {
	$key = 'HTTP_' . strtoupper(str_replace('-', '_', $name));
	if (is_string($_SERVER[$key] ?? null)) {
		return $_SERVER[$key];
	}
	if (function_exists('getallheaders')) {
		foreach (getallheaders() as $headerName => $value) {
			if (strcasecmp($headerName, $name) === 0 && is_string($value)) {
				return $value;
			}
		}
	}
	return '';
}

function paperApiFail(int $status, string $message): never {
	http_response_code($status);
	echo json_encode(['error' => $message], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), "\n";
	exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
	paperApiFail(405, 'Method not allowed');
}

FreshRSS_Context::initSystem();
if (!FreshRSS_Context::hasSystemConf() || !FreshRSS_Context::systemConf()->api_enabled) {
	paperApiFail(503, 'FreshRSS API is disabled');
}

$authorization = paperApiHeader('Authorization');
if (!preg_match('/^GoogleLogin\s+auth=([^\s]+)$/', $authorization, $matches)) {
	paperApiFail(401, 'Unauthorized');
}

$parts = explode('/', $matches[1], 2);
if (count($parts) !== 2 || !FreshRSS_user_Controller::checkUsername($parts[0])) {
	paperApiFail(401, 'Unauthorized');
}

[$username, $signature] = $parts;
FreshRSS_Context::initUser($username);
if (!FreshRSS_Context::hasUserConf() || !FreshRSS_Context::userConf()->enabled) {
	paperApiFail(401, 'Unauthorized');
}
Minz_Translate::init(FreshRSS_Context::userConf()->language);

$expected = sha1(FreshRSS_Context::systemConf()->salt . $username . FreshRSS_Context::userConf()->apiPasswordHash);
if (!hash_equals($expected, $signature)) {
	paperApiFail(401, 'Unauthorized');
}

$input = json_decode(file_get_contents('php://input') ?: '', true);
if (!is_array($input) || !preg_match('~^feed/(\d+)$~', (string)($input['id'] ?? ''), $idMatch)) {
    paperApiFail(400, 'Choose a feed');
}
$url = (string)($input['url'] ?? '');
$expectedUrl = (string)($input['expectedUrl'] ?? '');
if (strlen($url) > 4096 || !filter_var($url, FILTER_VALIDATE_URL) || !in_array(parse_url($url, PHP_URL_SCHEME), ['http', 'https'], true)) {
    paperApiFail(400, 'Invalid feed URL');
}
$feedDao = FreshRSS_Factory::createFeedDao();
$feed = null;
foreach ($feedDao->listFeeds() as $candidate) {
    if ((string)$candidate->id() === $idMatch[1]) $feed = $candidate;
    if (htmlspecialchars_decode($candidate->url(), ENT_QUOTES | ENT_HTML5) === $url && (string)$candidate->id() !== $idMatch[1]) {
        paperApiFail(409, 'That URL is already subscribed. No changes were made.');
    }
}
if ($feed === null) paperApiFail(404, 'Feed not found');
$currentUrl = htmlspecialchars_decode($feed->url(), ENT_QUOTES | ENT_HTML5);
if ($currentUrl === $url) { echo '{"ok":true}'; exit; }
if ($currentUrl !== $expectedUrl) paperApiFail(409, 'The feed URL changed. Reload before repairing it.');
// Update only the endpoint. IDs, entries, categories and state remain intact.
$result = $feedDao->updateFeed($feed->id(), ['url' => Minz_Helper::htmlspecialchars_utf8($url)]);
if ($result === false) paperApiFail(500, 'FreshRSS could not update the URL');
echo '{"ok":true}';
