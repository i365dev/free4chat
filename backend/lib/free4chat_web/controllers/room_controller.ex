defmodule Free4chatWeb.RoomController do
  use Free4chatWeb, :controller

  def scrape(conn, %{"room_id" => room_id}) do
    room_pid = :global.whereis_name(room_id)
    if is_pid(room_pid) do
      stats = GenServer.call(room_pid, :stats, 2000)
      json(conn, stats)
    else
      send_resp(conn, 404, "Room not found")
    end
  end
end
