//go:build !darwin

package credentials

func promptForSecret(string, string) (string, error) { return "", ErrUnavailable }
