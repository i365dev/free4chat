//go:build darwin

package credentials

import "testing"

func TestKeychainLocatorUsesStableServiceAndAccountOnly(t *testing.T) {
	service, account, label, accessGroup := keychainLocator("doubao", "apiKey")
	if service != serviceName || account != "doubao/apiKey" {
		t.Fatalf("unexpected keychain locator: service=%q account=%q", service, account)
	}
	if label != "" || accessGroup != "" {
		t.Fatalf("generic-password lookup must not require optional fields: label=%q accessGroup=%q", label, accessGroup)
	}
}
