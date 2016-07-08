package client

import (
	"net/http"
	"net/http/cookiejar"
)

type Client struct {
	HTTP    *http.Client
	filters []Filter
}

// Adds a filter which hooks into part of the HTTP lifecycle.
func (c *Client) AddFilter(f Filter) {
	c.filters = append(c.filters, f)
}

// EnableCookies sets the client up to send and track cookies from the server.
// It's required for password auth to work.
func (c *Client) EnableCookies() {
	jar, _ := cookiejar.New(nil)
	c.AddFilter(&cookieJar{jar: jar})
}

// UseOAuth adds a filter which includes an OAuth `Authorization` header
// in requests.
func (c *Client) UseOAuth(token string) {
	c.AddFilter(&oauthFilter{token: token})
}

func (c *Client) do(req *http.Request) (*http.Response, error) {
	for _, f := range c.filters {
		f.Before(req)
	}

	res, err := c.HTTP.Do(request)
	if err != nil {
		return res, err
	}

	for _, f := range c.filters {
		f.After(res)
	}

	return res, nil
}

// A Filter can be attached to the Client to modify outgoing requests.
// They can be used to implement authentication, user-agent handling, etc.
type Filter interface {
	Before(request *http.Request)
	After(response *http.Response)
}

// cookieJar stores HTTP cookies, adding them to requests and updating
// the jar based on responses.
type cookieJar struct{ jar http.CookieJar }

var _ Filter = new(cookieJar)

func (c *cookieJar) Before(req *http.Request) { req.Jar = c.jar }
func (c *cookieJar) After(res *http.Response) {}

// oauthFilter adds an `Authorization` header to outgoing requests.
type oauthFilter struct{ token string }

var _ Filter = new(oauthFilter)

func (o *oauthFilter) Before(req *http.Request) { req.Header.Set("Authorization", "OAuth "+o.token) }
func (o *oauthFilter) After(res *http.Response) {}
