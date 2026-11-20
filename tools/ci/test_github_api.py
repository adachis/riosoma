import io
import json
import os
import unittest
import urllib.error
from unittest.mock import patch

import github_api


class FakeResponse:
    def __init__(self, payload, link=""):
        self.payload = json.dumps(payload).encode()
        self.headers = {"Link": link}

    def read(self):
        return self.payload

    def __enter__(self):
        return self

    def __exit__(self, *exception):
        return False


class GitHubTest(unittest.TestCase):
    def setUp(self):
        self.requests = []
        self.responses = []
        opener = patch("urllib.request.urlopen", side_effect=self.answer)
        opener.start()
        self.addCleanup(opener.stop)
        self.client = github_api.GitHub("owner/repo", "token", "https://api.example.test/")

    def answer(self, request, timeout):
        self.requests.append(request)
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response

    def test_requests_carry_the_token_and_json(self):
        self.responses.append(FakeResponse({"number": 3}))
        self.assertEqual(self.client.create_issue("Title", "Body", ["label"]), {"number": 3})
        request = self.requests[0]
        self.assertEqual(request.full_url, "https://api.example.test/repos/owner/repo/issues")
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request.get_header("Authorization"), "Bearer token")
        self.assertEqual(json.loads(request.data), {"title": "Title", "body": "Body", "labels": ["label"]})

    def test_follows_pagination_and_drops_pull_requests(self):
        self.responses += [
            FakeResponse([{"number": 1}, {"number": 2, "pull_request": {}}], '<https://api.example.test/page2>; rel="next"'),
            FakeResponse([{"number": 3}]),
        ]
        self.assertEqual([i["number"] for i in self.client.issues("dependency-advisory")], [1, 3])
        self.assertIn("labels=dependency-advisory&state=all", self.requests[0].full_url)
        self.assertEqual(self.requests[1].full_url, "https://api.example.test/page2")

    def test_comment_calls(self):
        self.responses += [FakeResponse([]), FakeResponse({}), FakeResponse({}), FakeResponse({})]
        self.client.comments(5)
        self.client.comment(5, "hello")
        self.client.update_comment(9, "edited")
        self.client.update_issue(5, state="closed")
        self.assertEqual(
            [(r.get_method(), r.full_url.split("/repos/owner/repo")[1]) for r in self.requests],
            [
                ("GET", "/issues/5/comments?per_page=100"),
                ("POST", "/issues/5/comments"),
                ("PATCH", "/issues/comments/9"),
                ("PATCH", "/issues/5"),
            ],
        )

    def test_http_errors_become_github_errors(self):
        error = urllib.error.HTTPError("url", 403, "Forbidden", {}, io.BytesIO(b"Resource not accessible"))
        self.responses.append(error)
        with self.assertRaisesRegex(github_api.GitHubError, "403"):
            self.client.comment(5, "hello")

    def test_environment_is_required(self):
        with patch.dict(os.environ, {"GITHUB_TOKEN": "", "GITHUB_REPOSITORY": "owner/repo"}):
            with self.assertRaises(github_api.GitHubError):
                github_api.GitHub.from_environment()
        with patch.dict(os.environ, {"GITHUB_TOKEN": "t", "GITHUB_REPOSITORY": "o/r", "GITHUB_API_URL": "https://ghe.test/api/v3"}):
            client = github_api.GitHub.from_environment()
        self.assertEqual((client.repository, client.api_url), ("o/r", "https://ghe.test/api/v3"))


if __name__ == "__main__":
    unittest.main()
