defmodule Free4chat.Application do
  # See https://hexdocs.pm/elixir/Application.html
  # for more information on OTP Applications
  @moduledoc false

  use Application

  require Membrane.Logger

  @cert_file_path "priv/integrated_turn_cert.pem"

  @impl true
  def start(_type, _args) do
    config_common_dtls_key_cert()
    create_integrated_turn_cert_file()

    topologies = Application.get_env(:libcluster, :topologies) || []

    children = [
      # Start the Telemetry supervisor
      Free4chatWeb.Telemetry,
      # {Membrane.TelemetryMetrics.Reporter,
      #    [metrics: Membrane.RTC.Engine.Metrics.metrics(), name: Free4chatReporter]},
      # Start the PubSub system
      {Phoenix.PubSub, name: Free4chat.PubSub},
      {Registry, keys: :unique, name: Free4chat.Room.Registry},
      # Start the Endpoint (http/https)
      Free4chatWeb.Endpoint,
      # Start turn server before the cluster
      # Free4chat.TurnServer,
      # setup for clustering
      {Cluster.Supervisor, [topologies, [name: Free4chat.ClusterSupervisor]]}
      # Start a worker by calling: Free4chat.Worker.start_link(arg)
      # {Free4chat.Worker, arg}
    ]

    # See https://hexdocs.pm/elixir/Supervisor.html
    # for other strategies and supported options
    opts = [strategy: :one_for_one, name: Free4chat.Supervisor]
    Supervisor.start_link(children, opts)
  end

  @impl true
  def stop(_state) do
    delete_cert_file()
    :ok
  end

  defp create_integrated_turn_cert_file() do
    cert_path = Application.fetch_env!(:free4chat, :integrated_turn_cert)
    pkey_path = Application.fetch_env!(:free4chat, :integrated_turn_pkey)

    if cert_path != nil and pkey_path != nil do
      cert = File.read!(cert_path)
      pkey = File.read!(pkey_path)

      File.touch!(@cert_file_path)
      File.chmod!(@cert_file_path, 0o600)
      File.write!(@cert_file_path, "#{cert}\n#{pkey}")

      Application.put_env(:free4chat, :integrated_turn_cert_pkey, @cert_file_path)
    else
      Membrane.Logger.warn("""
      Integrated TURN certificate or private key path not specified.
      Integrated TURN will not handle TLS connections.
      """)
    end
  end

  defp delete_cert_file(), do: File.rm(@cert_file_path)

  defp config_common_dtls_key_cert() do
    # By default, generates new RSA key/cert pair
    {pkey, cert} = ExDTLS.generate_key_cert()
    Application.put_env(:free4chat, :dtls_pkey, pkey)
    Application.put_env(:free4chat, :dtls_cert, cert)
  end

  # Tell Phoenix to update the endpoint configuration
  # whenever the application is updated.
  @impl true
  def config_change(changed, _new, removed) do
    Free4chatWeb.Endpoint.config_change(changed, removed)
    :ok
  end
end
