defmodule Free4chat.Room do
  @moduledoc false

  use GenServer

  require Membrane.Logger

  alias Membrane.RTC.Engine
  alias Membrane.RTC.Engine.Endpoint.WebRTC
  alias Membrane.WebRTC.Extension.{Mid, Rid, TWCC}

  @mix_env Mix.env()

  @spec start(any(), list()) :: {:ok, pid()}
  def start(init_arg, opts), do: GenServer.start(__MODULE__, init_arg, opts)

  @spec start_link(any()) :: {:ok, pid()}
  def start_link(opts), do: GenServer.start_link(__MODULE__, [], opts)

  @impl true
  def init(args) do
    room_id = args.room_id
    simulcast? = args.simulcast?
    Membrane.Logger.info("Spawning room process: #{inspect(self())}")

    rtc_engine_options = [
      id: room_id
    ]

    turn_mock_ip = Application.fetch_env!(:free4chat, :integrated_turn_ip)
    turn_ip = if @mix_env == :prod, do: {0, 0, 0, 0}, else: turn_mock_ip

    turn_cert_file =
      case Application.fetch_env(:free4chat, :integrated_turn_cert_pkey) do
        {:ok, val} -> val
        :error -> nil
      end

    integrated_turn_options = [
      ip: turn_ip,
      mock_ip: turn_mock_ip,
      ports_range: Application.fetch_env!(:free4chat, :integrated_turn_port_range),
      cert_file: turn_cert_file
    ]

    network_options = [
      integrated_turn_options: integrated_turn_options,
      integrated_turn_domain: Application.fetch_env!(:free4chat, :integrated_turn_domain),
      dtls_pkey: Application.get_env(:free4chat, :dtls_pkey),
      dtls_cert: Application.get_env(:free4chat, :dtls_cert)
    ]

    {:ok, pid} = Membrane.RTC.Engine.start(rtc_engine_options, [])
    Engine.register(pid, self())
    Process.monitor(pid)

    {:ok,
     %{
       room_id: room_id,
       rtc_engine: pid,
       peer_channels: %{},
       network_options: network_options,
       simulcast?: simulcast?,
       # --- custom stats fields ---
       peers_joined: 0,
       text_events: 0
     }}
  end

  # When a peer joins
  @impl true
  def handle_info({:add_peer_channel, peer_channel_pid, peer_id}, state) do
    state = put_in(state, [:peer_channels, peer_id], peer_channel_pid)
    send(peer_channel_pid, {:simulcast_config, state.simulcast?})
    Process.monitor(peer_channel_pid)
    {:noreply, %{state | peers_joined: state.peers_joined + 1}}
  end

  @impl true
  def handle_info({:media_event, :broadcast, data}, state) do
    for {_peer_id, pid} <- state.peer_channels, do: send(pid, {:media_event, data})
    {:noreply, state}
  end

  @impl true
  def handle_info({:media_event, to, data}, state) do
    if state.peer_channels[to] != nil do
      send(state.peer_channels[to], {:media_event, data})
    end
    {:noreply, state}
  end

  @impl true
  def handle_info({:new_peer, rtc_engine, peer}, state) do
    Membrane.Logger.info("New peer: #{inspect(peer)}. Accepting.")
    peer_channel_pid = Map.get(state.peer_channels, peer.id)
    peer_node = node(peer_channel_pid)

    handshake_opts =
      if state.network_options[:dtls_pkey] && state.network_options[:dtls_cert] do
        [
          client_mode: false,
          dtls_srtp: true,
          pkey: state.network_options[:dtls_pkey],
          cert: state.network_options[:dtls_cert]
        ]
      else
        [
          client_mode: false,
          dtls_srtp: true
        ]
      end

    webrtc_extensions =
      if state.simulcast?, do: [Mid, Rid, TWCC], else: [TWCC]

    endpoint_opts = [
      rtc_engine: rtc_engine,
      ice_name: peer.id,
      owner: self(),
      integrated_turn_options: state.network_options[:integrated_turn_options],
      integrated_turn_domain: state.network_options[:integrated_turn_domain],
      handshake_opts: handshake_opts,
      log_metadata: [peer_id: peer.id],
      webrtc_extensions: webrtc_extensions,
      simulcast: state.simulcast?,
      peer_metadata: peer.metadata
    ]
    endpoint = WebRTC.new(endpoint_opts)

    Engine.accept_peer(rtc_engine, peer.id)
    :ok = Engine.add_endpoint(rtc_engine, endpoint, peer_id: peer.id, node: peer_node)
    {:noreply, state}
  end

  @impl true
  def handle_info({:peer_left, peer}, state) do
    Membrane.Logger.info("Peer #{inspect(peer.id)} left RTC Engine")
    {:noreply, state}
  end

  @impl true
  def handle_info({:endpoint_crashed, endpoint_id}, state) do
    Membrane.Logger.error("Endpoint #{inspect(endpoint_id)} has crashed!")
    peer_channel = state.peer_channels[endpoint_id]
    error_message = "WebRTC endpoint has crashed, please refresh the page to reconnect"
    send(peer_channel, {:media_event, error_message})
    {:noreply, state}
  end

  @impl true
  def handle_info({:media_event, _from, _event} = msg, state) do
    Engine.receive_media_event(state.rtc_engine, msg)
    {:noreply, state}
  end

  @impl true
  def handle_info({:text_event, from, event}, state) do
    for {peer_id, pid} <- state.peer_channels do
      if peer_id != from do
        send(pid, {:text_event, %{peerId: from, text: event}})
      end
    end
    {:noreply, %{state | text_events: state.text_events + 1}}
  end

  @impl true
  def handle_info({:DOWN, _ref, :process, pid, _reason}, state) do
    if pid == state.rtc_engine do
      {:stop, :normal, state}
    else
      {peer_id, _peer_channel_id} =
        state.peer_channels
        |> Enum.find(fn {_peer_id, peer_channel_pid} -> peer_channel_pid == pid end)

      {_elem, state} = pop_in(state, [:peer_channels, peer_id])
      if state.peer_channels == %{}, do: Engine.terminate(state.rtc_engine)
      {:noreply, state}
    end
  end

  # GenServer call for stats (for controller)
  @impl true
  def handle_call(:stats, _from, state) do
    stats = %{
      room_id: state.room_id,
      peer_count: map_size(state.peer_channels),
      peers_joined: state.peers_joined,
      text_events: state.text_events
    }
    {:reply, stats, state}
  end

  # Optionally, tracing helpers...
  defp tracing_metadata(), do: []
  defp room_span_id(id), do: "room:#{id}"
end
