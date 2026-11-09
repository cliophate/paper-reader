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

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET') {
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

$feedDao = FreshRSS_Factory::createFeedDao();
$categoryDao = FreshRSS_Factory::createCategoryDao();
$feeds = [];
foreach ($feedDao->listFeeds() as $feed) {
	if ($feed->priority() <= FreshRSS_Feed::PRIORITY_HIDDEN) {
		continue;
	}
	$lastUpdate = $feed->lastUpdate();
	$lastError = $feed->lastError();
	$feeds[] = [
		'id' => 'feed/' . $feed->id(),
		'broken' => $feed->inError(),
		'lastCheckedAt' => $lastUpdate > 0 ? date(DATE_ATOM, $lastUpdate) : null,
		'lastErrorAt' => $lastError > 1 ? date(DATE_ATOM, $lastError) : null,
	];
}

$folderOrder = [];
foreach ($categoryDao->listSortedCategories(false) as $category) {
	if ($category->id() === FreshRSS_CategoryDAO::DEFAULTCATEGORYID && $categoryDao->countFeed($category->id()) === 0) {
		continue;
	}
	$folderOrder[] = htmlspecialchars_decode($category->name(), ENT_QUOTES | ENT_HTML5);
}

echo json_encode([
	'feeds' => $feeds,
	'folderOrder' => $folderOrder,
], JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), "\n";
