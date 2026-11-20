"""The few GitHub REST calls the dependency jobs make, using only the standard library."""

import json
import os
import urllib.error
import urllib.request


class GitHubError(RuntimeError):
    pass


class GitHub:
    def __init__(self, repository, token, api_url="https://api.github.com"):
        self.repository = repository
        self.token = token
        self.api_url = api_url.rstrip("/")

    @classmethod
    def from_environment(cls):
        token = os.environ.get("GITHUB_TOKEN")
        repository = os.environ.get("GITHUB_REPOSITORY")
        if not token or not repository:
            raise GitHubError("GITHUB_TOKEN and GITHUB_REPOSITORY must be set")
        return cls(repository, token, os.environ.get("GITHUB_API_URL", "https://api.github.com"))

    def request(self, method, path, body=None):
        url = path if path.startswith("https://") else f"{self.api_url}/repos/{self.repository}{path}"
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(url, data=data, method=method)
        request.add_header("Accept", "application/vnd.github+json")
        request.add_header("Authorization", f"Bearer {self.token}")
        request.add_header("X-GitHub-Api-Version", "2022-11-28")
        if data is not None:
            request.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                payload = response.read()
                link = response.headers.get("Link", "")
        except urllib.error.HTTPError as error:
            raise GitHubError(f"{method} {url} failed with {error.code}: {error.read()[:300]!r}") from None
        return (json.loads(payload) if payload else None), link

    def paginate(self, path):
        results = []
        while path:
            page, link = self.request("GET", path)
            results.extend(page)
            path = None
            for part in link.split(","):
                if 'rel="next"' in part:
                    path = part[part.index("<") + 1 : part.index(">")]
        return results

    def issues(self, label):
        issues = self.paginate(f"/issues?labels={label}&state=all&per_page=100")
        # The issues endpoint also returns pull requests.
        return [issue for issue in issues if "pull_request" not in issue]

    def create_issue(self, title, body, labels):
        return self.request("POST", "/issues", {"title": title, "body": body, "labels": labels})[0]

    def update_issue(self, number, **fields):
        return self.request("PATCH", f"/issues/{number}", fields)[0]

    def comments(self, number):
        return self.paginate(f"/issues/{number}/comments?per_page=100")

    def comment(self, number, body):
        return self.request("POST", f"/issues/{number}/comments", {"body": body})[0]

    def update_comment(self, comment_id, body):
        return self.request("PATCH", f"/issues/comments/{comment_id}", {"body": body})[0]
